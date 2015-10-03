var Promise = require('bluebird');
var Stripe = require('stripe');
var fetch = require('node-fetch');
var utils = require('../../lib/utils');
var Boom = require('boom');

function checkSession( response ) {
	if ( !response.userCtx || !response.userCtx.name ) {
		throw Boom.unauthorized('Anonymous users can\'t subscribe');
	}
	else {
		return response.userCtx.name.replace(/^user\//, '');
	}
};

function getUserDoc( hoodie, userName ) {
	return new Promise(function(resolve, reject) {

		hoodie.account.find('user', userName, function( error, userDoc ) {
			if ( error ) {
				return reject( error );
			}

			if ( !userDoc.stripe ) {
				userDoc.stripe = {};
			}

			resolve( userDoc );
		});

	});
}

function stripeRetrieveToken( stripe, hoodie, userDoc, request ) {
	return new Promise(function(resolve, reject) {

		var requestData = request.payload.args[0];

		stripe.tokens.retrieve( requestData.source, function( error, token ) {
			if ( error ) {
				return reject( error );
			}

			userDoc.stripe.tokenId = token.id;
			userDoc.stripe.country = token.card.country;

			resolve( userDoc );
		});

	});
}

function taxamoTransactionCreate( stripe, hoodie, userDoc, request ) {
	var customer = userDoc.stripe;
	var requestData = request.payload.args[0];

	var payload = {
		transaction: {
			'transaction_lines': [
				{
					'custom_id': 'fuckoff',
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
	.then(function(response) {
		userDoc.taxamo = {
			taxamoKey: response.transaction.key,
			taxNumber: requestData.taxNumber,
			taxPercent: response.transaction['tax_amount'],
		};

		return userDoc;
	});
}

function stripeCustomerCreate( stripe, hoodie, userDoc, request ) {
	return new Promise(function(resolve, reject) {

		var customer = userDoc.stripe;
		var tax = userDoc.taxamo;
		var requestData = request.payload.args[0];

		if ( customer.customerId ) {
			throw Boom.forbidden('Already a customer');
		}

		stripe.customers.create({
			'description': 'Customer for ' + userDoc.name.split('/')[1],
			'source': requestData.source,
			'plan': requestData.plan || 'personnal',
			'tax_percent': tax.taxNumber,
			'metadata': {
				'hoodieId': userDoc.id,
				'taxamo_transaction_key': tax.taxamoKey,
			},

		}, function( error, response ) {
			if ( error ) {
				return reject( error );
			}

			var subscription = response.subscriptions.data[0];

			customer.customerId = response.id;
			customer.subscriptionId = subscription.id;
			customer.plan = subscription.plan.id;
			userDoc.roles.push( 'stripe:plan:' + subscription.plan.id );

			return resolve( userDoc );
		});

	});
}

// Update the subscription info on the userDoc
function stripeSubscriptionUpdate( stripe, hoodie, userDoc, request ) {
	return new Promise(function(resolve, reject) {
		var customer = userDoc.stripe;
		var requestData = request.payload.args[0];

		if ( !customer || !customer.customerId ) {
			throw Boom.forbidden('not a customer');
		}
		if ( !customer || !customer.subscriptionId ) {
			throw Boom.forbidden('no subscription');
		}

		stripe.customers.updateSubscription(
			customer.customerId,
			customer.subscriptionId,
			{
				plan: requestData.plan || 'personnal',
			},
			function( error, subscription ) {
				if ( error ) {
					return reject( err );
				}

				customer.plan = subscription.plan.id;
				userDoc.roles.forEach(function( role, i ) {
					if ( role.indexOf('stripe:plan:') === 0 ) {
						userDoc.roles[i] = 'stripe:plan:' + customer.plan;
					}
				});

				return resolve( userDoc );
			}
		);
	});
}

function updateAccount( stripe, hoodie, userDoc ) {
	var deferred = Promise.pending();

	hoodie.account.update('user', userDoc.id, userDoc, function(error) {
		if ( error ) {
			return deferred.reject( error );
		}

		return deferred.resolve( userDoc );
	});

	return deferred.promise;
}

module.exports = function handleCustomerRequest( hoodie, request, reply ) {
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

	fetch('http://' + request.info.host + '/_api/_session', {
			method: 'get',
			headers: {
				'authorization': request.headers.authorization,
				'accept': 'application/json',
			},
			cookie: request.headers.cookie,
		})
		.then(utils.checkStatus)
		.then(utils.parseJson)
		.then(checkSession)
		.then(function(userName) {
			return getUserDoc( hoodie, userName );
		})
		// verify stripeToken and extract country code
		.then(function(nextDoc) {
			if ( request.payload.method === 'customers.create' ) {
				return stripeRetrieveToken(
					stripe, hoodie, nextDoc, request );
			}

			return nextDoc;
		})
		// create palceholder taxamo transaction
		.then(function(nextDoc) {
			if ( request.payload.method === 'customers.create' ) {
				return taxamoTransactionCreate(
					stripe, hoodie, nextDoc, request );
			}

			return nextDoc;
		})
		// create stripe customer with reference to placeholder transaction
		.then(function(nextDoc) {
			if ( request.payload.method === 'customers.create' ) {
				return stripeCustomerCreate(
					stripe, hoodie, nextDoc, request );
			}

			return nextDoc;
		})
		// create or update subscription
		.then(function( nextDoc ) {
			if ( request.payload.method === 'customers.update' ) {
				return stripeSubscriptionUpdate(
					stripe, hoodie, nextDoc, request );
			}

			return nextDoc;
		})
		.then(function( nextDoc ) {
			return updateAccount( stripe, hoodie, nextDoc, request );
		})
		.then(function(nextDoc) {
			return reply( null, { plan: nextDoc.stripe.plan });
		})
		.catch(function( error ) {
			return reply( error );
		});
}
