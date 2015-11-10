var Promise = require('bluebird');
var Boom = require('boom');

// parseJson always happens first after a fetch, and only checks Content-Type.
// In many cases the response.status can be an error but useful body has
// been sent.
module.exports.parseJson = function( response ) {
	if ( response.headers.get('Content-Type').indexOf('json') !== -1 ) {
		return response.json()
			.then(function( body ) {
				return {
					response: response,
					body: body,
				};
			});
	}

	var error = new Error(
			response.ok ? 'Unexpected Content-Type' : response.statusText );
	error.response = response;
	throw error;
};

module.exports.checkStatus = function( args ) {
	var response = args.response;
	var body = args.body;

	if ( response.ok ) {
		return body;
	}

	throw Boom.create( response.status, response.statusText, body );
};

module.exports.fetchStripePlan = function( stripe, id ) {
	return new Promise(function(resolve, reject) {
		stripe.plans.retrieve(id, function( error, plan ) {
			if ( error ) {
				reject(error);
			}

			global.allStripePlans[plan.id] = plan;
			return resolve();
		});
	});
};

module.exports.fetchAllStripePlans = function( stripe, args ) {
	global.allStripePlans = {};

	return new Promise(function(resolve, reject) {
		// args is only used in unit tests to test recursivity by fetching only
		// one plan in the first request.
		return fetchStripePlans(
			stripe, resolve, reject, args || { limit: 100 } );
	});
};

function fetchStripePlans( stripe, resolve, reject, args ) {
	stripe.plans.list( args, function( error, plans ) {
		if ( error ) {
			return reject( error );
		}

		var lastPlan;

		plans.data.forEach(function(plan) {
			lastPlan = plan.id;
			global.allStripePlans[plan.id] = plan;
		});

		if ( plans['has_more'] === true ) {
			fetchStripePlans( stripe, resolve, reject, {
				// recursive calls to the function always use the highest limit
				limit: 100,
				'starting_after': lastPlan,
			});
		}
		else {
			resolve(global.allStripePlans);
		}
	});
}
