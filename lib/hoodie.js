var Promise = require('bluebird');
var Boom = require('boom');
var utils = require('./fetch');
var fetch = require('node-fetch');

var hoodie = {};

hoodie.fetchSession = function( context ) {
	var request = context.request;
	var sessionUri = [
		request.server.info.protocol + '://',
		context.hoodie.env.host + ':',
		context.hoodie.env['www_port'],
		'/_api/_session',
	].join('');

	return fetch(sessionUri, {
			method: 'get',
			headers: {
				'authorization': request.headers.authorization,
				'accept': 'application/json',
			},
			cookie: request.headers.cookie,
			// session shouldn't take longer than that
			timeout: 4000,
		})
		.then(utils.parseJson)
		.then(utils.checkStatus)
		.then(function( response ) {
			if ( !response.userCtx || !response.userCtx.name ) {
				throw Boom.unauthorized('Anonymous users can\'t do this');
			}
			else {
				context.userName = response.userCtx.name.replace(/^user\//, '');
			}
		});
};

hoodie.accountFind = function( context ) {
	return Promise.promisify(
			context.hoodie.account.find,
			{ context: context.hoodie.account }
		)(
			'user',
			context.userName
		)
		.then(function( userDoc ) {
			context.userDoc = userDoc;

			return userDoc;
		});
};

hoodie.accountUpdateOrNot = function( context ) {
	if ( !context.userNeedsUpdate ) {
		return;
	}

	hoodie.planToRole( context.userDoc );

	return Promise.promisify(
			context.hoodie.account.update,
			{ context: context.hoodie.account }
		)(
			'user',
			context.userDoc.id,
			context.userDoc
		);
};

hoodie.planToRole = function( userDoc ) {
	// delete/update/add the plan to the roles object
	var updated;
	userDoc.roles.forEach(function( role, i ) {
		if ( role.indexOf('stripe:plan:') === 0 ) {
			updated = true;
			if ( userDoc.stripe.plan ) {
				userDoc.roles[i] = 'stripe:plan:' + userDoc.stripe.plan;
			}
			else {
				userDoc.roles.splice(i, 1);
			}

		}
	});
	if ( !updated && userDoc.stripe.plan ) {
		userDoc.roles.push( 'stripe:plan:' + userDoc.stripe.plan );
	}
};

module.exports = hoodie;
