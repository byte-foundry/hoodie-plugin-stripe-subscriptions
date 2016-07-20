var Promise = require('bluebird');
var utils = require('../../lib/utils');
var _ = require('lodash');

module.exports = function customersUpdateHandler( context ) {
	return Promise.resolve()
		.then(_.partial(utils.hoodie.fetchSession, context))
		.then(_.partial(utils.hoodie.accountFind, context))
		.then(function() {
			if ( context.userDoc.stripe && context.userDoc.stripe.customerId ) {
				return utils.stripe.customersRetrieveOrNot( context )
					.then(_.partial(utils.stripe.chargesListOrNot, context));
			}
			else {
				return (
					utils.stripe.customersCreateOrNot( context )
						.then(function() {
							return utils.hoodie.accountUpdateOrNot( context );
						})
				);
			}
		})
		.then(_.partial(utils.hoodie.accountUpdateOrNot, context))
		.then(function() {
			_.assign( context.customer, {
				plan: context.userDoc.stripe.plan,
				authorization: context.request.headers.authorization,
			});
			context.reply( null, context.customer );
		});
};
