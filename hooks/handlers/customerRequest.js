var Promise = require('bluebird');
var Stripe = require('stripe');
var fetch = require('node-fetch');
var utils = require('../../lib/utils');
var Boom = require('boom');

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

	// We're gonna start by doing two things in parallel
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
	if ( requestData && requestData.source ) {
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

	// There's a short path for 'customers.retrieve'
	if ( requestMethod === 'customers.retrieve' ) {
		return promises[0]
			.then(function( nextDoc ) {
				return stripeCustomerRetrieve(
					stripe, hoodie, nextDoc, request, logger );
			})
			.then(function( customer ) {
				// Note: we send the content of the whole customer object stored
				// in Stripe. There shouldn't be any confidential info in there.
				return reply( null, customer );
			})
			.catch(function( error ) {
				logger.error(error, error.stack);
				return reply( error );
			});
	}

	// and longer ones for other methods
	Promise.all(promises)
		.then(function( results ) {
			var nextDoc = results[0];
			var taxamoInfo = results[1];

			if ( taxamoInfo && 'key' in taxamoInfo ) {
				nextDoc.taxamo = taxamoInfo
			}
			logger.log('taxamoInfo', taxamoInfo);

			// There's a special option to only accept plans priced in euro for
			// EU customers.
			if ( hoodie.config.get('euroInEU') && nextDoc.taxamo &&
					nextDoc.taxamo['tax_region'] === 'EU' &&
					requestData.currencyCode !== 'EUR' ) {

				throw Boom.forbidden(
					'European customers must choose a plan in euro.');
			}

			return nextDoc;
		})
		.then(function(nextDoc) {
			if ( requestMethod === 'customers.create' ) {
				return stripeCustomerCreate(
					stripe, hoodie, nextDoc, request, logger );
			}

			// This will be used to change payment method
			// if a payment has been provided then it has already been verified
			if ( requestMethod === 'customers.update' ||
					( requestMethod === 'customers.updateSubscription' &&
					requestData.source ) ) {

				return stripeCustomerUpdate(
					stripe, hoodie, nextDoc, request, logger );
			}

			return nextDoc;
		})
		.then(function( nextDoc ) {
			// if no token has been sent but the user is already a customer,
			// update its subscription
			if ( requestMethod === 'customers.updateSubscription' ) {
				return stripeUpdateSubscription(
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
				throw Boom.unauthorized('Anonymous users can\'t do this');
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
				},
			],
			'currency_code': requestData.currencyCode || 'USD',
			'description': 'placeholder transaction',
			'status': 'C',
			'buyer_credit_card_prefix': requestData.cardPrefix,
			'force_country_code': token.card.country,
		},
	};

	if ( token['client_ip'] ) {
		body.transaction['buyer_ip'] = token['client_ip'];
	}

	if ( requestData.taxNumber ) {
		body.transaction['buyer_tax_number'] = requestData.taxNumber;
		// dynamic pricing for B2B
		body.transaction['transaction_lines'][0].amount = 0;
	}
	// when a test key is used, request are allowed to force 'tax_deducted'
	else if ( /^sk_test_/.test( hoodie.config.get('stripeKey') ) &&
			requestData.taxDeducted ) {
		body.transaction['tax_deducted'] = true;
		// dynamic pricing for B2B
		body.transaction['transaction_lines'][0].amount = 0;
	}
	else {
		// universal pricing for B2C
		body.transaction['transaction_lines'][0]['total_amount'] = 0;
	}

	// When a test key is used, requests are allowed to overwrite country_code
	if ( /^sk_test_/.test( hoodie.config.get('stripeKey') ) &&
			requestData.countryCode ) {
		body.transaction['force_country_code'] = requestData.countryCode;
	}

	var headers = {
		'Content-Type': 'application/json',
		'Accept': 'application/json',
		'Private-Token': hoodie.config.get('taxamoKey'),
	};

	return fetch('https://api.taxamo.com/api/v1/transactions', {
			method: 'post',
			headers: headers,
			body: JSON.stringify(body),
			timeout: 3000,
		})
		.then(utils.parseJson)
		.then(utils.checkStatus)
		.then(function( _transaction ) {
			var transaction = _transaction.transaction;
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

			logger.log( taxamo );
			return taxamo;
		});
}

function stripeCustomerRetrieve( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var customer = userDoc.stripe;

		if ( !customer || !customer.customerId ) {
			return reject( Boom.forbidden(
				'Cannot retrieve customer: user isn\'t a customer.') );
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

function stripeCustomerCreate( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var requestData = request.payload.args[0];
		var taxamo = userDoc.taxamo;

		if ( userDoc.stripe && userDoc.stripe.customerId ) {
			return reject( Boom.forbidden(
				'Cannot create customer: user is already a customer.') );
		}

		stripe.customers.create({
			description: 'Customer for ' + userDoc.name.split('/')[1],
			source: requestData.source,
			plan: requestData.plan,
			coupon: requestData.coupon,
			metadata: {
				'hoodieId': userDoc.id,
				'taxamo_transaction_key': taxamo && taxamo.key,
			},

		}, function( error, body ) {
			if ( error ) {
				return reject( error );
			}

			userDoc.stripe.customerId = body.id;
			userDoc.stripe.subscriptionId = body.subscriptions.data[0].id;
			userDoc.stripe.plan = body.subscriptions.data[0].plan.id;

			logger.log( 'customer create' );
			logger.log( userDoc, body );
			return resolve( userDoc );
		});

	});
}

function stripeCustomerUpdate( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var requestData = request.payload.args[0];
		var customer = userDoc.stripe;
		var taxamo = userDoc.taxamo;

		if ( !customer || !customer.customerId ) {
			return reject( Boom.forbidden(
				'Cannot update customer: Customer doesn\'t exist.') );
		}
		if ( !requestData.source ) {
			return reject( Boom.forbidden(
				'Cannot update customer: no source provided.') );
		}

		stripe.customers.update( customer.customerId, {
			'source': requestData.source,
			'coupon': requestData.coupon,
			'metadata': {
				'hoodieId': userDoc.id,
				'taxamo_transaction_key': taxamo && taxamo.key,
			},

		}, function( error, body ) {
			if ( error ) {
				return reject( error );
			}

			logger.log( body );
			return resolve( userDoc );
		});

	});
}

// Update the subscription info on the userDoc
function stripeUpdateSubscription( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
		var requestData = request.payload.args[0];
		var customer = userDoc.stripe;

		if ( !customer || !customer.customerId ) {
			return reject( Boom.forbidden(
				'Cannot update subscription: user isn\'t a customer.') );
		}
		if ( !customer || !customer.subscriptionId ) {
			return reject( Boom.forbidden(
				'Cannot update subscription: user has no subscription.') );
		}

		stripe.customers.updateSubscription(
			customer.customerId,
			customer.subscriptionId,
			{
				plan: requestData.plan,
				coupon: requestData.coupon,
			},
			function( error, body ) {
				if ( error ) {
					return reject( error );
				}

				userDoc.stripe.plan = body.plan.id;

				logger.log( body );
				return resolve( userDoc, body );
			}
		);
	});
}

function updateAccount( stripe, hoodie, userDoc, request, logger ) {
	return new Promise(function(resolve, reject) {
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

			logger.log( userDoc );

			return resolve( userDoc );
		});

	});
}

module.exports = handleCustomerRequest;
module.exports.taxamoTransactionCreate = taxamoTransactionCreate;
module.exports.stripeCustomerCreate = stripeCustomerCreate;
module.exports.stripeCustomerUpdate = stripeCustomerUpdate;
module.exports.stripeUpdateSubscription = stripeUpdateSubscription;
module.exports.updateAccount = updateAccount;
