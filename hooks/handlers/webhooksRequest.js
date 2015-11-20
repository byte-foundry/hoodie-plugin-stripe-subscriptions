var utils = ('../../lib/utils');

module.exports = function handleWebhooksRequest( hoodie, request, reply ) {
	var event = request.payload;
	var usersDb = hoodie.database('_users');

	// For now we will ignore all events except subscriptions
	if ( !event.object || event.object.object !== 'subscription' ) {
		return;
	}

	var customerId = event.object.customer;
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

			utils.hoodie.planToRole( userDoc );

			usersDb.update('user', docId, userDoc, function(error) {
				if (error) {
					return reply(new Error(error));
				}

				reply('success');
			});
		});
	});
};
