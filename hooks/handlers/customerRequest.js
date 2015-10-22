var Promise = require('bluebird');
var Stripe = require('stripe');
var fetch = require('node-fetch');
var utils = require('../../lib/utils');
var Boom = require('boom');
var _ = require('lodash');

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

	// 2. Verify the stripe token
	if ( requestData && requestData.source ) {
		promises.push(
			stripeRetrieveToken(
				stripe, hoodie, requestData.source, request, logger)
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
			var token = results[1];

			if ( hoodie.config.get('taxamoKey') && token && token.card ) {
				return taxamoTransactionCreate(
						stripe, hoodie, results, request, logger
					)
					.then(function( taxamo ) {
						nextDoc.taxamo = taxamo;

						// There's a special option to only accept plans priced
						// in euro for EU customers.
						if (
							hoodie.config.get('euroInEU') &&
							taxamo['tax_region'] === 'EU' &&
							requestData['currency_code'] !== 'EUR'
						) {
							throw Boom.forbidden(
								'European customers must choose a plan in euro.'
							);
						}

						return nextDoc;
					});
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
			if (
				requestMethod === 'customers.update' ||
				// We also need to update the customer on updateSubscription
				// when a source is provided, because a new taxamo transaction
				// has been created and it must appear in the metadata of the
				// Stripe customer.
				( requestMethod === 'customers.updateSubscription' &&
				requestData.source )
			) {

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

function taxamoTransactionCreate( stripe, hoodie, results, request, logger ) {
	var requestData = request.payload.args[0];
	var userDoc = results[0];
	var token = results[1];
	var whitelist = [
		'currency_code',
		'buyer_credit_card_prefix',
		'buyer_email',
		'buyer_tax_number',
	];
	// mix following object with whitelisted properties from requestData
	var body = _.mixin({
			transaction: {
				'transaction_lines': [
					{
						'custom_id': 'dontRemoveThisProp',
						'amount': 0,
					},
				],
				'currency_code': 'USD',
				'description': 'placeholder transaction',
				'status': 'C',
				'force_country_code': token.card.country,
				'customer_id': userDoc.id,
			},
		},
		_.pick(requestData, function( value, key ) {
			return _.includes( whitelist, key );
		}));

	if (
		!requestData['buyer_tax_number'] &&
		hoodie.config.get('universalPricing')
	) {
		// universal pricing (only applies to B2C transactions)
		delete body.transaction['transaction_lines'][0].amount;
		body.transaction['transaction_lines'][0]['total_amount'] = 0;
	}

	if ( token['client_ip'] ) {
		body.transaction['buyer_ip'] = token['client_ip'];
	}

	// when a test key is used, request are allowed to force 'tax_deducted'
	if (
		/^sk_test_/.test( hoodie.config.get('stripeKey') ) &&
		requestData['tax_deducted']
	) {
		body.transaction['tax_deducted'] = requestData['tax_deducted'];
	}

	// When a test key is used, requests are allowed to overwrite country_code
	if (
		/^sk_test_/.test( hoodie.config.get('stripeKey') ) &&
		requestData['force_country_code']
	) {
		body.transaction['force_country_code'] = (
			requestData['force_country_code']
		);
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
		if ( userDoc.stripe && userDoc.stripe.customerId ) {
			return reject( Boom.forbidden(
				'Cannot create customer: user is already a customer.') );
		}

		var requestData = request.payload.args[0];
		var taxamo = userDoc.taxamo;
		var config = hoodie.config;
		var whitelist = [
				'source',
				'plan',
				'coupon',
			];
		// mix following object with whitelisted properties from requestData
		var params = _.mixin({
				'description': 'Customer for ' + userDoc.name.split('/')[1],
				'tax_percent': !taxamo || config.get('universalPricing') ?
					0 :
					taxamo['tax_rate'],
				'metadata': {
					'hoodieId': userDoc.id,
					'taxamo_transaction_key': taxamo && taxamo.key,
				},
			},
			_.pick(requestData, function( value, key ) {
				return _.includes( whitelist, key );
			}));

		stripe.customers.create( params, function( error, body ) {
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

		var whitelist = [
				'source',
				'coupon',
			];
		// mix following object with whitelisted properties from requestData
		var params = _.mixin({
				'metadata': {
					'hoodieId': userDoc.id,
					'taxamo_transaction_key': taxamo && taxamo.key,
				},
			},
			_.pick(requestData, function( value, key ) {
				return _.includes( whitelist, key );
			}));

		stripe.customers.update( customer.customerId, params,
			function( error, body ) {
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
		var taxamo = userDoc.taxamo;
		var config = hoodie.config;

		if ( !customer || !customer.customerId ) {
			return reject( Boom.forbidden(
				'Cannot update subscription: user isn\'t a customer.') );
		}
		if ( !customer || !customer.subscriptionId ) {
			return reject( Boom.forbidden(
				'Cannot update subscription: user has no subscription.') );
		}

		var whitelist = [
				'plan',
				'coupon',
			];
		// mix following object with whitelisted properties from requestData
		var params = _.mixin({
				'tax_percent': !taxamo || config.get('universalPricing') ?
					0 :
					taxamo['tax_rate'],
			},
			_.pick(requestData, function( value, key ) {
				return _.includes( whitelist, key );
			}));

		stripe.customers.updateSubscription(
			customer.customerId,
			customer.subscriptionId,
			params,
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
