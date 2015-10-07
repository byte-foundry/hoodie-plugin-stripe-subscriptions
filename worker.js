var Promise = require('bluebird');

module.exports = function hoodiePluginStripeTaxamo(hoodie, callback) {
	var promises = [
			createPluginDb(hoodie),
			createUserIndex(hoodie),
		];

	// We used to try to fetchAllStripePlans here before,
	// but sometimes the API can't be fetched and in this cases this causes
	// hard to debug troubles in hoodie and appback.
	// Generally it is safer not to try to reach outside world while starting
	// the plugin

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
				/* eslint-disable no-console */
				console.log(error);
				/* eslint-enable no-console */
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
					/* eslint-disable no-undef */
					emit(doc.stripe.customerId);
					/* eslint-enable no-undef */
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
