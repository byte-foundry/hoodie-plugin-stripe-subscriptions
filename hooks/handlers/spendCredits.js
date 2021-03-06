var Promise = require('bluebird');
var utils = require('../../lib/utils');
var _ = require('lodash');

module.exports = function spendCreditsHandler( context ) {
	return Promise.all([
			Promise.resolve()
				.then(_.partial(utils.hoodie.fetchSession, context ))
				.then(_.partial(utils.hoodie.accountFind, context )),
		])
		.then(function() {
			if ( context.userDoc.stripe && context.userDoc.stripe.customerId ) {
				return utils.stripe.customersRetrieveOrNot( context );
			}
			else {
				return utils.stripe.customersCreateOrNot( context )
					.then(_.partial(utils.hoodie.accountUpdateOrNot, context ));
			}
		})
		.then(function() {
			context.credits =
				parseInt( (context.customer.metadata.credits || 0), 10)
				- parseInt( context.args[0], 10);
		})
		.then(_.partial(utils.stripe.customerCreditsUpdateOrNot, context))
		.then(function() {
			// TODO: return -1 when the number of credits was already 0 before
			// the request
			_.assign( context.customer, {
				credits: context.credits || 0,
				authorization: context.request.headers.authorization,
			});
			context.reply( null, context.customer );
		});
};
