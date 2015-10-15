var Promise = require('bluebird');
var Stripe = require('stripe');
var fetch = require('node-fetch');
var utils = require('../../lib/utils');
var Boom = require('boom');

var rTaxfree = /_taxfree$/;

// things that bit us with chrome logger:
// - it adds properties to logged objects
// - all external request need to have a timeout, or logs might never come
// - it's easy to exceed the maximum headers size when you log too much

function handleCustomerRequest( hoodie, request, reply ) {
	var logger = request.raw.res.chrome;

	if ( request.method !== 'post' ) {
		return reply( Boom.methodNotAllowed() );
	}

	if ( !hoodie.config.get('stripeKey') ) {
		return reply( Boom.expectationFailed( 'Stripe key not configured') );
	}
	var stripe = Stripe( hoodie.config.get('stripeKey') );

	var requestMethod = request.payload.method;
	var requestData = request.payload.args && request.payload.args[0];

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
					if ( hoodie.config.get('taxamoKey') ) {
						return taxamoTransactionCreate(
							stripe, hoodie, token, request, logger );
					}
				})
		);
	}

	// 3. Fetch all stripe plans if needed
	if ( !global.allStripePlans ||
			Object.keys( global.allStripePlans ).length === 0 ) {
		promises.push( utils.fetchAllStripePlans( stripe ) );
	}
	// ... or fetch just the requested stripe plan if needed
	else if ( requestData.plan &&
			!( requestData.plan in global.allStripePlans ) ) {
		promises.push(
			utils.fetchStripePlan( stripe, requestData.plan  )
		);
	}

	Promise.all(promises)
		.then(function( results ) {
			var nextDoc = results[0];
			var taxamoInfo = results[1];

			if ( taxamoInfo && 'key' in taxamoInfo ) {
				nextDoc.taxamo = taxamoInfo
			}

			return nextDoc;
		})
		// verify plan and create a plan matching local tax amount if necessary
		.then(function(nextDoc) {
			if ( requestData.plan ) {
				return localizePlan(
					stripe, hoodie, nextDoc, request, logger );
			}

			return nextDoc;
		})
		.then(function(nextDoc) {
			if ( requestMethod === 'customer.create' ) {
				return stripeCustomerCreate(
					stripe, hoodie, nextDoc, request, logger );
			}

			// This will be used to change payment method
			// if a payment has been provided than it has already been verified
			if ( requestMethod === 'customer.update' && requestData.source ) {
				return stripeCustomerUpdate(
					stripe, hoodie, nextDoc, request, logger );
			}

			// used to retrieve payment and subscription info
			if ( requestMethod === 'customer.retrieve' && requestData.source ) {
				return stripeCustomerRetrieve(
					stripe, hoodie, nextDoc, request, logger );
			}

			// if no token has been sent but the user is already a customer,
			// update its subscription
			if ( requestMethod === 'customer.create' &&
					nextDoc.stripe && nextDoc.stripe.customerId ) {
				return stripeSubscriptionUpdate(
					stripe, hoodie, nextDoc, request, logger );
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
		.then(function( response ) {
			if ( !response.userCtx || !response.userCtx.name ) {
				throw Boom.unauthorized('Anonymous users can\'t subscribe');
			}
			else {
				return response.userCtx.name.replace(/^user\//, '');
			}
		});
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

	var body = {
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
		// TODO: when all tests pass, try without this (it's already a header)
		'private_token': hoodie.config.get('taxamoKey'),
	};

	if ( token['client_ip'] ) {
		body['buyer_ip'] = token['client_ip'];
	}
	if ( requestData.taxNumber ) {
		body['buyer_tax_number'] = requestData.taxNumber;
	}

	var headers = {
		'Content-Type': 'application/json',
		'Accept': 'application/json',
		'Private-Token': hoodie.config.get('taxamoKey'),
	};

	var promises = [];

	promises.push(
		fetch('https://api.taxamo.com/api/v1/transactions', {
			method: 'post',
			headers: headers,
			body: JSON.stringify(body),
			timeout: 3000,
		})
		.then(utils.parseJson)
		.then(utils.checkStatus)
	);

	// If a taxNumber has been provided, we need a second request to check the
	// tax rate in the buyer's country. This is required to calculate universal
	// pricing
	if ( requestData.taxNumber ) {
		promises.push(
			fetch('https://api.taxamo.com/api/v1/tax/calculate', {
				method: 'post',
				headers: headers,
				body: JSON.stringify({
					'currency_code': requestData.currencyCode || 'USD',
					'amount': 0,
					'force_country_code': token.card.country,
				}),
				timeout: 3000,
			})
			.then(utils.parseJson)
			.then(utils.checkStatus)
		);
	}

	return Promise.all(promises)
		.then(function( results ) {
			var transaction = results[0].transaction;
			var taxamo = {
				'key': transaction.key,
				'buyer_tax_number': transaction['buyer_tax_number'],
				'tax_rate': transaction['transaction_lines'][0]['tax_rate'],
				'tax_region': transaction['tax_region'],
				'tax_country_code': transaction['tax_country_code'],
				'tax_deducted': transaction['tax_deducted'],
				'billing_country_code': transaction['billing_country_code'],
				'currency_code': transaction['currency_code'],
			};

			taxamo['country_tax_rate'] = results[1] && results[1].transaction ?
				results[1].transaction['transaction_lines'][0]['tax_rate'] :
				taxamo['tax_rate'];

			logger.log( taxamo );
			return taxamo;
		});
}

function localizePlan( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var requestData = request.payload.args[0];

		var basePlan = global.allStripePlans[requestData.plan];
		if ( !basePlan ) {
			return reject( Boom.forbidden('Base plan doesn\'t exist.') );
		}

		// don't try to localize the plan if universal pricing isn't enabled,
		// if plan is free, or if the country_tax_rate is 0.
		if ( !hoodie.config.get('universalPricing') || basePlan.amount === 0 ||
				(userDoc.taxamo && userDoc.taxamo['country_tax_rate'] === 0) ) {
			userDoc.localPlanId = basePlan.id;

			logger.log( userDoc );
			return resolve( userDoc );
		}

		// with universal pricing we need taxamo info and a taxfree plan
		if ( !userDoc.taxamo ) {
			return reject( Boom.forbidden(
				'User has no transaction. Cannot update subscription.') );
		}
		if ( !userDoc.taxamo['country_tax_rate'] ) {
			return reject( Boom.forbidden(
				'User has no valid tax rate. Cannot update subscription.') );
		}
		if ( !rTaxfree.test(basePlan.id) ) {
			return reject( Boom.forbidden(
				'Universal pricing is enabled, only plans with "_taxfree" ' +
				'suffix are allowed in requests.') );
		}

		// We're good, localize the plan.
		var countryTaxRate = userDoc.taxamo['country_tax_rate'];
		var localPlan = {
			// that's where all the magic happens
			amount: Math.floor(
				( basePlan.amount ) / ( (countryTaxRate / 100) + 1 ) ),
			interval: basePlan.interval,
			currency: basePlan.currency,
		};

		userDoc.localPlanId =
			basePlan.id.replace(rTaxfree, countryTaxRate + 'tax');

		// There's a special option to bill european clients in euro with
		// eur/usd parity
		// TODO: implement advanced currency and amount conversion
		if ( hoodie.config.get('eurusdParity') &&
				userDoc.taxamo['tax_region'] === 'EU' ) {
			userDoc.localPlanId = userDoc.localPlanId.replace('USD', 'EUR');
			localPlan.currency = 'eur';
		}

		localPlan.id = userDoc.localPlanId;
		localPlan.name = userDoc.localPlanId;

		// add optional parameters
		if ( basePlan['interval_count'] ) {
			localPlan['interval_count'] = basePlan['interval_count'];
		}
		if ( basePlan['trial_period_days'] ) {
			localPlan['trial_period_days'] = basePlan['trial_period_days'];
		}
		if ( basePlan.metadata ) {
			localPlan.metadata = basePlan.metadata;
		}
		if ( basePlan['statement_descriptor'] ) {
			localPlan['statement_descriptor'] =
				basePlan['statement_descriptor'];
		}

		stripe.plans.create(localPlan, function(error, plan) {
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
		var taxamo = userDoc.taxamo;
		var requestData = request.payload.args[0];

		if ( userDoc.stripe && userDoc.stripe.customerId ) {
			return reject( Boom.forbidden(
				'User is already a customer. Cannot create customer.') );
		}

		stripe.customers.create({
			'description': 'Customer for ' + userDoc.name.split('/')[1],
			'source': requestData.source,
			'plan': userDoc.localPlanId,
			'tax_percent': hoodie.config.get('taxRate') || taxamo ?
				taxamo.taxRate :
				0,
			'metadata': {
				'hoodieId': userDoc.id,
				'taxamo_transaction_key': taxamo && taxamo.id,
			},

		}, function( error, body ) {
			if ( error ) {
				return reject( error );
			}

			userDoc.stripe.customerId = body.id;
			userDoc.stripe.subscriptionId = body.subscriptions.data[0].id;

			logger.log( userDoc, body );
			return resolve( userDoc );
		});

	});
}

function stripeCustomerUpdate( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var requestData = request.payload.args[0];
		var customer = userDoc.stripe;

		if ( !customer || !customer.customerId ) {
			return reject( Boom.forbidden(
				'Customer doesn\'t exist. Cannot update customer.') );
		}

		stripe.customers.update( customer.customerId, {
			'source': requestData.source,

		}, function( error, body ) {
			if ( error ) {
				return reject( error );
			}

			logger.log( body );
			return resolve( userDoc );
		});

	});
}

function stripeCustomerRetrieve( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var customer = userDoc.stripe;

		if ( !customer || !customer.customerId ) {
			return reject( Boom.forbidden(
				'Customer doesn\'t exist. Cannot update customer.') );
		}

		stripe.customers.retrieve(customer.customerId, function( error, body ) {
			if ( error ) {
				return reject( error );
			}

			logger.log( body );
			return resolve( body );
		});

	});
}

// Update the subscription info on the userDoc
function stripeSubscriptionUpdate( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var requestData = request.payload.args[0];
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
				source: requestData.source,
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

module.exports = handleCustomerRequest;
module.exports.taxamoTransactionCreate = taxamoTransactionCreate;
module.exports.localizePlan = localizePlan;
module.exports.stripeCustomerCreate = stripeCustomerCreate;
module.exports.stripeCustomerUpdate = stripeCustomerUpdate;
module.exports.stripeSubscriptionUpdate = stripeSubscriptionUpdate;
module.exports.updateAccount = updateAccount;
