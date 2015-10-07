var Promise = require('bluebird');
var Stripe = require('stripe');
var fetch = require('node-fetch');
var utils = require('../../lib/utils');
var Boom = require('boom');

// things that bit us with chrome logger:
// - it adds properties to logged objects
// - all external request need to have a timeout, or logs might never come
// - it's easy to exceed the maximum headers size when you log too much

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
	var requestData = request.payload.args && request.payload.args[0];
	if ( !requestData || !requestData.plan ) {
		return reply( Boom.badRequest( 'plan property is mandatory') );
	}

	// We're gonna start by doing three things in parallel
	var promises = [];

	// 1. Verify the user session and get its userDoc
	promises.push(
		requestSession( stripe, hoodie, null, request, logger )
			.then(function(userName) {
				return getUserDoc(
					stripe, hoodie, userName, request, logger );
			})
	);

	// 2. Verify the stripe token and create a taxamo transaction if needed
	if ( requestData.source ) {
		promises.push(
			stripeRetrieveToken(
				stripe, hoodie, requestData.source, request, logger)
				.then(function( token ) {
					return taxamoTransactionCreate(
						stripe, hoodie, token, request, logger );
				})
		);
	}

	// 3. Fetch all stripe plans if needed
	if ( !global.allStripePlans ||
			Object.keys( global.allStripePlans ).length === 0 ) {
		promises.push( utils.fetchAllStripePlans( stripe ) );
	}
	// ... or fetch just the requested stripe plan if needed
	else if ( !( requestData.plan in global.allStripePlans ) ) {
		promises.push(
			utils.fetchStripePlan( stripe, requestData.plan  )
		);
	}

	Promise.all(promises)
		.then(function( results ) {
			var nextDoc = results[0];
			var taxamoInfo = results[1];

			if ( taxamoInfo && 'taxCountryCode' in taxamoInfo ) {
				nextDoc.taxamo = taxamoInfo
			}

			return nextDoc;
		})
		// verify plan and build plan Id that matches VAT amount
		.then(function(nextDoc) {
			return buildLocalPlanId(
				stripe, hoodie, nextDoc, request, logger );
		})
		// create the plan in stripe if it doesn't exist yet
		.then(function(nextDoc) {
			if ( !(nextDoc.localPlanId in global.allStripePlans ) ) {
				return stripePlanCreate(
					stripe, hoodie, nextDoc, request, logger );
			}

			return nextDoc;
		})
		.then(function(nextDoc) {
			// if a token has been sent, try to create the user and subscription
			if ( requestData.source ) {
				return stripeCustomerCreate(
					stripe, hoodie, nextDoc, request, logger );
			}

			// if no token has been sent but the user is already a customer,
			// update its subscription
			if ( nextDoc.stripe && nextDoc.stripe.customerId ) {
				return stripeSubscriptionUpdate(
					stripe, hoodie, nextDoc, request, logger );
			}

			// otherwise double-check that we're dealing with a free plan
			if ( nextDoc.localPlanId.indexOf('free_') !== 0 ) {
				throw Boom.forbidden('Only free plans allowed without token.');
			}

			return nextDoc;
		})
		.then(function( nextDoc ) {
			return updateAccount( stripe, hoodie, nextDoc, request, logger );
		})
		.then(function(nextDoc) {
			return reply( null, {
				plan: nextDoc.stripe.plan,
				authorization: request.headers.authorization,
			});
		})
		.catch(function( error ) {
			logger.error(error, error.stack);
			return reply( error );
		});
}

function requestSession( stripe, hoodie, nextDoc, request, logger ) {
	var sessionUri = hoodie.config.get('sessionUri');
	if ( !sessionUri ) {
		sessionUri =
			request.server.info.protocol +
			'://' +
			request.info.host +
			'/_api/_session';
	}

	logger.log(sessionUri, request.headers.authorization);

	return fetch(sessionUri, {
			method: 'get',
			headers: {
				'authorization': request.headers.authorization,
				'accept': 'application/json',
			},
			cookie: request.headers.cookie,
			// session shouldn't take longer than that
			timeout: 4000,
		})
		.then(utils.parseJson)
		.then(utils.checkStatus)
		.then(checkSession);
}

function checkSession( response ) {
	if ( !response.userCtx || !response.userCtx.name ) {
		throw Boom.unauthorized('Anonymous users can\'t subscribe');
	}
	else {
		return response.userCtx.name.replace(/^user\//, '');
	}
}

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

function stripeRetrieveToken( stripe, hoodie, source, request, logger ) {
	return new Promise(function(resolve, reject) {
		stripe.tokens.retrieve( source, function( error, token ) {
			if ( error ) {
				return reject( error );
			}

			logger.log( token );
			return resolve( token );
		});
	});
}

function taxamoTransactionCreate( stripe, hoodie, token, request, logger ) {
	var requestData = request.payload.args[0];

	var transaction = {
		transaction: {
			'transaction_lines': [
				{
					'custom_id': 'dontRemoveThisProp',
					'amount': 0,
				},
			],
			'currency_code': requestData.currencyCode || 'USD',
			'description': 'placeholder transaction',
			'status': 'C',
			'buyer_credit_card_prefix': requestData.cardPrefix,
			'force_country_code': token.card.country,
		},
		'private_token': hoodie.config.get('taxamoKey'),
	};

	// let's try to rull out local IPV4 adresses
	// TODO: investigate what happens with IPV6 LAN addresses
	var remote = request.info.remoteAddress;
	if ( remote !== '127.0.0.1' && remote.indexOf('192.168.') !== 0 &&
			remote.indexOf('10.') !== 0 ) {
		transaction['buyer_ip'] = request.info.remoteAddress;
	}
	if ( requestData.taxNumber ) {
		transaction['buyer_tax_number'] = requestData.taxNumber;
	}

	return fetch('https://api.taxamo.com/api/v1/transactions', {
		method: 'post',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'Private-Token': hoodie.config.get('taxamoKey'),
		},
		body: JSON.stringify(transaction),
		timeout: 3000,
	})
	.then(utils.parseJson)
	.then(utils.checkStatus)
	.then(function(body) {
		var taxamo = {
			id: body.transaction.key,
			taxNumber: body.transaction['buyer_tax_number'],
			taxRate: body.transaction['transaction_lines'][0]['tax_rate'],
			taxRegion: body.transaction['tax_region'],
			taxCountryCode: body.transaction['tax_country_code'],
			taxDeducted: body.transaction['tax_deducted'],
			billingCountryCode: body.transaction['billing_country_code'],
		};

		logger.log( transaction, body );
		return taxamo;
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

		// subscription to a free plan
		if ( ( !requestData.source && !userDoc.stripe.customerId ) ||
				basePlan.id.indexOf('free_') === 0 ) {

			if ( basePlan.id.indexOf('free_') !== 0 ) {
				return reject(
					Boom.forbidden('Only free plans allowed without token.') );
			}

			userDoc.localPlanId = basePlan.id;

			logger.log( userDoc );
			return resolve( userDoc );
		}

		if ( !userDoc.taxamo ) {
			return reject( Boom.forbidden(
				'User has no transaction. Cannot update subscription.') );
		}
		if ( !userDoc.taxamo.taxCountryCode ) {
			return reject( Boom.forbidden(
				'User has no valid country. Cannot update subscription.') );
		}

		if ( userDoc.taxamo.taxRegion !== 'EU' ) {
			userDoc.localPlanId = basePlan.id;

			logger.log( userDoc );
			return resolve( userDoc );
		}

		// User is in the EU. Let's find a plan that matches local VAT
		if ( userDoc.taxamo.taxRate !== 0 ) {
			userDoc.localPlanId =
				basePlan.id
					.replace('USD', 'EUR')
					.replace(/taxfree/, userDoc.taxamo.taxRate + 'VAT');

			logger.log( userDoc );
			return resolve( userDoc );
		}

		// if taxRate was null, we need to fetch a useful VAT rate
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
				'force_country_code': userDoc.taxamo.taxCountryCode,
			}),
			timeout: 3000,
		})
		.then(utils.parseJson)
		.then(utils.checkStatus)
		.then(function(body) {
			userDoc.taxamo.taxRate =
				body.transaction['transaction_lines'][0]['tax_rate'];
			userDoc.localPlanId =
				basePlan.id
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

			customer.customerId = body.id;
			customer.subscriptionId = subscription.id;

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
					return reject( error );
				}

				logger.log( body )
				return resolve( userDoc, body );
			}
		);
	});
}

function updateAccount( stripe, hoodie, userDoc ) {
	return new Promise(function(resolve, reject) {

		userDoc.stripe.plan = userDoc.localPlanId;
		delete userDoc.localPlanId;

		// update or add the plan to the roles object
		var updated;
		userDoc.roles.forEach(function( role, i ) {
			if ( role.indexOf('stripe:plan:') === 0 ) {
				updated = true;
				userDoc.roles[i] = 'stripe:plan:' + userDoc.stripe.plan;
			}
		});
		if ( !updated ) {
			userDoc.roles.push( 'stripe:plan:' + userDoc.stripe.plan );
		}

		hoodie.account.update('user', userDoc.id, userDoc, function(error) {
			if ( error ) {
				return reject( error );
			}

			return resolve( userDoc );
		});

	});
}
