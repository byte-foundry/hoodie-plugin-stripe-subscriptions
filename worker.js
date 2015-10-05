var Promise = require('bluebird');
var Stripe = require('stripe');

global.allStripePlans = {};

module.exports = function hoodiePluginStripeTaxamo(hoodie, callback) {
	var stripeKey = hoodie.config.get('stripeKey');
	if ( !stripeKey ) {
		return reject( new Error('Stripe key not configured') );
	}

	var stripe = Stripe(stripeKey);

	Promise.all([
			createPluginDb(hoodie),
			createUserIndex(hoodie),
			module.exports.fetchAllStripePlans(stripe),
		])
		.then(function() {
			callback();
		})
		.catch(function(error) {
			callback(error);
		});
};

function createPluginDb(hoodie) {
	return new Promise(function(resolve, reject) {
		hoodie.database.add('plugin/stripe', function(error) {
			if ( error && error.error !== 'file_exists' ) {
				console.log(error);
				return reject(error);
			}

			resolve();
		});
	});
};

// create /_users/_design/plugin%2fstripe
// with _view/by-id
function createUserIndex(hoodie) {
	return new Promise(function(resolve, reject) {
		var usersDb = hoodie.database('_users');
		var indexName = 'stripe-by-id';

		var mapReduce = {
			map: function(doc) {
				if ( doc.stripe && doc.stripe.customerId ) {
					emit(doc.stripe.customerId);
				}
			},
		};
		usersDb.addIndex(indexName, mapReduce, function(error) {
			if ( error ) {
				return reject(error);
			}

			return resolve();
		});
	});
};

module.exports.fetchAllStripePlans = function( stripe, args ) {
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
