var Promise = require('bluebird');
var Stripe = require('stripe');
var utils = require('./lib/utils');

module.exports = function hoodiePluginStripeTaxamo(hoodie, callback) {
	var promises = [
			createPluginDb(hoodie),
			createUserIndex(hoodie),
		];

	// only fetch stripe plans if stripeKey is already configured
	var stripeKey = hoodie.config.get('stripeKey');
	if ( stripeKey ) {
		var stripe = Stripe(stripeKey)
		promises.push(utils.fetchAllStripePlans(stripe))
	}

	Promise.all(promises)
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
}

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
}
