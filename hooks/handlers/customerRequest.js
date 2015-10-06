var Promise = require('bluebird');
var Stripe = require('stripe');
var fetch = require('node-fetch');
var utils = require('../../lib/utils');
var Boom = require('boom');

module.exports = function handleCustomerRequest( hoodie, request, reply ) {
	var logger = request.raw.res.chrome;

	if ( request.method !== 'post' ) {
		return reply( Boom.methodNotAllowed() );
	}

	var stripeKey = hoodie.config.get('stripeKey');
	if ( !stripeKey ) {
		return reply( Boom.expectationFailed( 'Stripe key not configured') );
	}
	var stripe = Stripe(stripeKey);
	if ( !hoodie.config.get('taxamoKey') ) {
		return reply( Boom.expectationFailed( 'Taxamo key not configured') );
	}
	if ( !request.payload.args || !request.payload.args[0] ||
			!request.payload.args[0].plan ) {
		return reply( Boom.badRequest( 'plan property is mandatory') );
	}

	var promises = [ requestSession( request ) ];

	if ( !global.allStripePlans ) {
		promises.push( utils.fetchAllStripePlans( stripe ) );
	}

	Promise.all(promises)
		.then(function() {
			return arguments[0];
		})
		.then(function(userName) {
			return getUserDoc(
				stripe, hoodie, userName, request, logger );
		})
		// verify stripeToken and extract country code
		.then(function(nextDoc) {
			if ( request.payload.method === 'customers.create' &&
					( request.payload.args[0] || {} ).source ) {
				return stripeRetrieveToken(
					stripe, hoodie, nextDoc, request, logger );
			}

			return nextDoc;
		})
		// create palceholder taxamo transaction
		.then(function(nextDoc) {
			if ( request.payload.method === 'customers.create' &&
					( request.payload.args[0] || {} ).source ) {
				return taxamoTransactionCreate(
					stripe, hoodie, nextDoc, request, logger );
			}

			return nextDoc;
		})
		// build plan Id that matches VAT amount
		.then(function(nextDoc) {
			return buildLocalPlanId(
				stripe, hoodie, nextDoc, request, logger );
		})
		.then(function(nextDoc) {
			if ( !(nextDoc.localPlanId in global.allStripePlans ) ) {
				return stripePlanCreate(
					stripe, hoodie, nextDoc, request, logger );
			}

			return nextDoc;
		})
		// create stripe customer with reference to placeholder transaction
		.then(function(nextDoc) {
			if ( request.payload.method === 'customers.create' ) {
				return stripeCustomerCreate(
					stripe, hoodie, nextDoc, request, logger );
			}

			return nextDoc;
		})
		// create or update subscription
		.then(function( nextDoc ) {
			if ( request.payload.method === 'customers.update' ) {
				return stripeSubscriptionUpdate(
					stripe, hoodie, nextDoc, request, logger );
			}

			return nextDoc;
		})
		.then(function( nextDoc ) {
			return updateAccount( stripe, hoodie, nextDoc, request, logger );
		})
		.then(function(nextDoc) {
			return reply( null, { plan: nextDoc.stripe.plan });
		})
		.catch(function( error ) {
			logger.error(error, error.stack);
			return reply( error );
		});
}

function requestSession( request ) {
	return fetch('http://' + request.info.host + '/_api/_session', {
			method: 'get',
			headers: {
				'authorization': request.headers.authorization,
				'accept': 'application/json',
			},
			cookie: request.headers.cookie,
		})
		.then(utils.checkStatus)
		.then(utils.parseJson)
		.then(checkSession);
}

function checkSession( response ) {
	if ( !response.userCtx || !response.userCtx.name ) {
		throw Boom.unauthorized('Anonymous users can\'t subscribe');
	}
	else {
		return response.userCtx.name.replace(/^user\//, '');
	}
};

function getUserDoc( stripe, hoodie, userName, request, logger ) {
	return new Promise(function(resolve, reject) {

		hoodie.account.find('user', userName, function( error, userDoc ) {
			if ( error ) {
				return reject( error );
			}

			if ( !userDoc.stripe ) {
				userDoc.stripe = {};
			}

			logger.log( userDoc );
			return resolve( userDoc );
		});

	});
}

function stripeRetrieveToken( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {

		var requestData = request.payload.args[0];

		stripe.tokens.retrieve( requestData.source, function( error, token ) {
			if ( error ) {
				return reject( error );
			}

			userDoc.stripe.tokenId = token.id;
			userDoc.stripe.country = token.card.country;

			logger.log( userDoc );
			return resolve( userDoc );
		});

	});
}

function taxamoTransactionCreate( stripe, hoodie, userDoc, request, logger ) {
	var customer = userDoc.stripe;
	var requestData = request.payload.args[0];

	var payload = {
		transaction: {
			'transaction_lines': [
				{
					'custom_id': 'dontRemoveThisProp',
					'amount': 0,
				},
			],
			'currency_code': requestData.currencyCode || 'USD',
			'description': 'placeholder transaction',
			'status': 'C',
			'buyer_credit_card_prefix': requestData.cardPrefix,
			'force_country_code': customer.country,
		},
		'private_token': hoodie.config.get('taxamoKey'),
	};

	if (request.info.remoteAddress !== '127.0.0.1') {
		payload['buyer_ip'] = request.info.remoteAddress;
	}
	if (requestData.taxNumber) {
		payload['buyer_tax_number'] = requestData.taxNumber;
	}

	return fetch('https://api.taxamo.com/api/v1/transactions', {
		method: 'post',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'Private-Token': hoodie.config.get('taxamoKey'),
		},
		body: JSON.stringify(payload),
	})
	.then(utils.checkStatus)
	.then(utils.parseJson)
	.then(function(body) {
		userDoc.taxamo = {
			id: body.transaction.key,
			taxNumber: body.transaction['buyer_tax_number'],
			taxRate: body.transaction['transaction_lines'][0]['tax_rate'],
			taxRegion: body.transaction['tax_region'],
			taxCountryCode: body.transaction['tax_region'],
			taxDeducted: body.transaction['tax_deducted'],
		};

		logger.log( userDoc, body );
		return userDoc;
	});
}

function buildLocalPlanId( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var requestData = request.payload.args[0];

		if ( requestData.plan.split('_').indexOf('taxfree') === -1 ) {
			return reject( Boom.forbidden('Base plan isn\'t taxfree.') );
		}

		var basePlan = global.allStripePlans[requestData.plan];
		if ( !basePlan ) {
			return reject( Boom.forbidden('Base plan doesn\'t exist.') );
		}

		if ( !userDoc.stripe || !userDoc.taxamo ) {
			return reject( Boom.forbidden(
				'Customer doesn\'t exist. Cannot update subscription.') );
		}

		userDoc.localPlanId = requestData.plan;
		if ( userDoc.taxamo.taxRegion !== 'EU' ) {
			logger.log( userDoc );
			return resolve( userDoc );
		}

		// User is in the EU. Let's find a plan that matches local VAT
		if ( userDoc.taxamo.taxRate !== 0 ) {
			userDoc.localPlanId =
				userDoc.localPlanId
					.replace('USD', 'EUR')
					.replace(/taxfree/, userDoc.taxamo.taxRate + 'VAT');

			logger.log( userDoc );
			return resolve( userDoc );
		}

		// if taxRate was null, we need to
		fetch('https://api.taxamo.com/api/v1/tax/calculate', {
			method: 'post',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'Private-Token': hoodie.config.get('taxamoKey'),
			},
			body: JSON.stringify({
				'currency_code': 'EUR',
				'amount': 0,
				'force_country_code': userDoc.stripe.country,
			}),
		})
		.then(utils.checkStatus)
		.then(utils.parseJson)
		.then(function(body) {
			userDoc.taxamo.taxRate =
				body.transaction['transaction_lines'][0]['tax_rate'];
			userDoc.localPlanId =
				userDoc.localPlanId
					.replace('USD', 'EUR')
					.replace(/taxfree/, userDoc.taxamo.taxRate + 'VAT');

			logger.log( userDoc, body );
			return resolve( userDoc );
		})
		.catch(function(error) {
			return reject( error );
		});
	});
}

function stripePlanCreate( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var requestData = request.payload.args[0];

		var basePlan = global.allStripePlans[requestData.plan];
		if ( !basePlan ) {
			return reject( Boom.forbidden('Base plan doesn\'t exist.') );
		}

		var newPlan = {
			'id': userDoc.localPlanId,
			'name': userDoc.localPlanId,
			'interval': basePlan.interval,
			'amount': Math.floor(
				( basePlan.amount ) / ( userDoc.taxamo.taxRate / 100 + 1 ) ),
			'currency': 'EUR',
		};

		if ( basePlan['interval_count'] ) {
			newPlan['interval_count'] = basePlan['interval_count'];
		}
		if ( basePlan['trial_period_days'] ) {
			newPlan['trial_period_days'] = basePlan['trial_period_days'];
		}
		if ( basePlan.metadata ) {
			newPlan.metadata = basePlan.metadata;
		}
		if ( basePlan['statement_descriptor'] ) {
			newPlan['statement_descriptor'] = basePlan['statement_descriptor'];
		}

		stripe.plans.create(newPlan, function(error, plan) {
			if ( error ) {
				return reject( error );
			}

			global.allStripePlans[plan.id] = plan;

			logger.log( userDoc, plan );
			return resolve( userDoc );
		});
	});
}

function stripeCustomerCreate( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {

		var customer = userDoc.stripe;
		var taxamo = userDoc.taxamo;
		var requestData = request.payload.args[0];

		if ( customer.customerId ) {
			return reject( Boom.forbidden(
				'User is already a customer. Cannot create customer.') );
		}

		stripe.customers.create({
			'description': 'Customer for ' + userDoc.name.split('/')[1],
			'source': requestData.source,
			'plan': userDoc.localPlanId,
			'tax_percent': taxamo.taxRate,
			'metadata': {
				'hoodieId': userDoc.id,
				'taxamo_transaction_key': taxamo.id,
			},

		}, function( error, body ) {
			if ( error ) {
				return reject( error );
			}

			var subscription = body.subscriptions.data[0];

			delete userDoc.localPlanId;
			customer.customerId = body.id;
			customer.subscriptionId = subscription.id;
			customer.plan = subscription.plan.id;
			userDoc.roles.push( 'stripe:plan:' + subscription.plan.id );

			logger.log( userDoc, body );
			return resolve( userDoc );
		});

	});
}

// Update the subscription info on the userDoc
function stripeSubscriptionUpdate( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var customer = userDoc.stripe;

		if ( !customer || !customer.customerId ) {
			return reject( Boom.forbidden(
				'Customer doesn\'t exist. Cannot update subscription.') );
		}
		if ( !customer || !customer.subscriptionId ) {
			return reject( Boom.forbidden(
				'Subscription doesn\'t exist. Cannot update subscription.') );
		}

		stripe.customers.updateSubscription(
			customer.customerId,
			customer.subscriptionId,
			{
				plan: userDoc.localPlanId,
			},
			function( error, body ) {
				if ( error ) {
					return reject( err );
				}

				delete userDoc.localPlanId;
				customer.plan = body.plan.id;
				userDoc.roles.forEach(function( role, i ) {
					if ( role.indexOf('stripe:plan:') === 0 ) {
						userDoc.roles[i] = 'stripe:plan:' + customer.plan;
					}
				});

				logger.log( userDoc, body )
				return resolve( userDoc, body );
			}
		);
	});
}

function updateAccount( stripe, hoodie, userDoc ) {
	return new Promise(function(resolve, reject) {

		hoodie.account.update('user', userDoc.id, userDoc, function(error) {
			if ( error ) {
				return reject( error );
			}

			return resolve( userDoc );
		});

	});
}
