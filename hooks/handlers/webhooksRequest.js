var utils = ('../../lib/utils');

module.exports = function handleWebhooksRequest( hoodie, request, reply ) {
	var event = request.payload;
	var usersDb = hoodie.database('_users');

	// For now we will ignore all events except subscriptions
	if ( !event.type || !/^customer.subscription/.test( event.type ) ) {
		return reply( null, 'event ignored' );
	}

	var customerId = event.data.object.customer;
	var queryArgs = {
		'include_docs': true,
		startkey: customerId,
		limit: 1,
	};

	usersDb.query('stripe-by-id', queryArgs, function(error, rows) {
		if (error) {
			return reply(new Error(error));
		}

		var docId = rows._id;

		usersDb.find('user', docId, function(error, userDoc) {
			if (error) {
				return reply(new Error(error));
			}

			if ( event.type === 'customer.subscription.deleted' ) {
				userDoc.stripe.plan = 'free_none';
				delete userDoc.stripe.subscriptionId;
			}
			else {
				userDoc.stripe.plan = event.data.object.plan.id;
			}

			utils.hoodie.planToRole( userDoc );

			usersDb.update('user', docId, userDoc, function(error) {
				if (error) {
					return reply(new Error(error));
				}

				reply( null, 'success' );
			});
		});
	});
};
