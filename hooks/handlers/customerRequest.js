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
	var deferred = Promise.pending();

	hoodie.account.find('user', userName, function( error, currDoc ) {
		if ( error ) {
			return deferred.reject( error );
		}

		deferred.resolve( currDoc );
	});

	return deferred.promise;
}

function stripeCustomerCreate( stripe, hoodie, userDoc, request ) {
	var deferred = Promise.pending();
	var _customer = utils.getCustomerInfo( userDoc );
	var requestData = request.payload.args[0];

	if ( _customer.customerId ) {
		throw Boom.forbidden('Already a customer');
	}

	stripe.customers.create({
		description: 'Customer for ' + userDoc.name.split('/')[1],
		source: requestData.source,
		// we no longer subscribe the customr immediatly, as we need to know
		// it's country ID to calculate VATMOSS compliant tax rates.
		// plan: requestData.plan,
		metadata: {
			hoodieId: userDoc.id,
		},

	}, function( error, customer ) {
		if ( error ) {
			return deferred.reject( error );
		}

		userDoc.stripe = {
			customerId: customer.id,
			country: customer.sources.data[0].country,
		};

		return deferred.resolve( userDoc );
	});

	return deferred.promise;
}

function taxamoTransactionCreate( hoodie, userDoc, request ) {
	var customer = userDoc.stripe;
	var requestData = request.payload.args[0];

	var payload = {
		transaction: {
			'transaction_lines': [
				{
					'custom_id': 'fuckoff',
					'amount': 1,
				},
			],
			'currency_code': requestData.currencyCode || 'USD',
			'description': 'placeholder transaction',
			'status': 'C',
			'buyer_credit_card_prefix': requestData.cardPrefix,
			'force_country_code': customer.country,
			// ugliest way to serialize a map, brought to you by Taxamo
			'custom_fields': [
				{
					key: 'stripe_customer_id',
					value: customer.customerId,
				},
				{
					key: 'hoodie_user_id',
					value: userDoc.id,
				},
			],
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
			taxNumber: requestData.taxNumber,
			taxPercent: response['tax_amount'],
			taxamoKey: response.key,
		};

		return userDoc;
	});
}

// Save the subscription info to the useDoc
function stripeSubscriptionCreate( stripe, hoodie, userDoc, request ) {
	var deferred = Promise.pending();
	var customer = userDoc.stripe;
	var tax = userDoc.taxamo;
	var requestData = request.payload.args[0];

	if ( !customer.customerId ) {
		throw Boom.unauthorized('Not a customer');
	}

	stripe.customers.createSubscription(
		customer.customerId,
		{
			'plan': requestData.plan || 'personnal',
			'tax_percent': tax.taxNumber,
			'metadata': {
				'hoodieId': userDoc.id,
				// TODO: use taxamo_key
				'taxamo_key': tax.taxamoKey,
			},
		},
		function( error, subscription ) {
			if ( error ) {
				return deferred.reject( err );
			}

			customer.subscriptionId = subscription.id;
			customer.plan = subscription.plan.id;
			userDoc.roles.push( 'stripe:plan:' + subscription.plan.id );

			hoodie.account.update('user', userDoc.id, userDoc, function(error) {
				if ( error ) {
					return deferred.reject( error );
				}

				return deferred.resolve( userDoc );
			});
		}
	);

	return deferred.promise;
}

// Update the subscription info on the userDoc
function stripeSubscriptionUpdate( stripe, hoodie, userDoc, request ) {
	var deferred = Promise.pending();
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
				return deferred.reject( err );
			}

			customer.plan = subscription.plan.id;
			userDoc.roles.forEach(function( role, i ) {
				if ( role.indexOf('stripe:plan:') === 0 ) {
					userDoc.roles[i] = 'stripe:plan:' + subscription.plan.id;
				}
			});

			hoodie.account.update('user', userDoc.id, userDoc, function(error) {
				if ( error ) {
					return deferred.reject( error );
				}

				return deferred.resolve( userDoc );
			});
		}
	);

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
		.then(function(currDoc) {
			if ( request.payload.method === 'customers.create' ) {
				return stripeCustomerCreate(
					stripe, hoodie, currDoc, request );
			}

			return currDoc;
		})
		.then(function(nextDoc) {
			if ( request.payload.method === 'customers.create' ) {
				return taxamoTransactionCreate( hoodie, nextDoc, request );
			}

			return nextDoc;
		})
		.then(function( nextDoc ) {
			if ( request.payload.method === 'customers.create' ) {
				return stripeSubscriptionCreate(
					stripe, hoodie, nextDoc, request );
			}
			else if ( request.payload.method === 'customers.update' ) {
				return stripeSubscriptionUpdate(
					stripe, hoodie, nextDoc, request );
			}
		})
		.then(function(nextDoc) {
			return reply( null, { plan: nextDoc.stripe.plan });
		})
		.catch(function(err) {
			return reply( err );
		});
}
