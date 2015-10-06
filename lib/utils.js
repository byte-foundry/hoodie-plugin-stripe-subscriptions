var Promise = require('bluebird');
var Stripe = require('stripe');

module.exports.checkStatus = function( response ) {
	if (response.status >= 200 && response.status < 300) {
		return response;
	}
	else {
		var error = new Error(response.statusText);
		error.response = response;
		throw error;
	}
}

module.exports.parseJson = function( response ) {
	return response.json();
};

module.exports.fetchAllStripePlans = function( stripe, args ) {
	global.allStripePlans = {};

	return new Promise(function(resolve, reject) {
		// args is only used in unit tests to test recursivity by fetching only
		// one plan in the first request.
		return fetchStripePlans(
			stripe, resolve, reject, args || { limit: 100 } );
	});
}

fetchStripePlans = function( stripe, resolve, reject, args ) {
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

module.exports.stripeTokensCreate = function( card, callback ) {
	if ( !process.env.STRIPE_KEY ) {
		throw new Error('STRIPE_KEY env variable required');
	}

	stripe = Stripe(process.env.STRIPE_KEY);

	stripe.tokens.create({
		card: card,
	}, callback );
}
