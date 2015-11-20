var Promise = require('bluebird');
var utils = require('../../lib/utils');
var _ = require('lodash');

module.exports = function invoicesRetrieveUpcomingHandler( context ) {
	return Promise.resolve()
		.then(_.partial( utils.hoodie.fetchSession, context ))
		.then(_.partial( utils.hoodie.accountFind, context ))
		.then(_.partial( utils.stripe.customersCreateOrNot, context ))
		.then(function() {
			return Promise.all([
				utils.hoodie.accountUpdateOrNot( context ),
				utils.stripe.invoicesRetrieveUpcoming( context ),
			]);
		})
		.spread(function( userDoc, upcoming ) {
			context.reply( null, upcoming );
		})
		.catch(_.partial(utils.replyError, context));
};
