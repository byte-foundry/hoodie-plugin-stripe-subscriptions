if ( typeof require !== 'undefined' ) {
	var expect = require('chai').expect;
	var utils = require('../lib/utils');
	var Stripe = require('stripe');

	var STRIPE_KEY = process.env.STRIPE_KEY;
}

describe('utils.js', function() {
	describe('fetchAllStripePlans', function() {
		it('should return more than one plan', function(done) {
			this.timeout(5000);

			if ( typeof STRIPE_KEY === 'undefined' ) {
				throw new Error('STRIPE_KEY env variable required');
			}

			var stripe = Stripe(STRIPE_KEY);

			utils.fetchAllStripePlans( stripe, { limit: 1 } )
				.then(function(allStripePlans) {
					expect(Object.keys(allStripePlans).length)
						.to.be.above(1);
					done();
				});
		});
	});
});
