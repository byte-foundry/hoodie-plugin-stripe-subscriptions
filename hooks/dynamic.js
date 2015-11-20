/*
	Hooks allow you to alter the behaviour of hoodie-server,
	Hoodie’s core backend module.

	This is possible:
	- get a notification when something in hoodie-server happens
	- extend core features of hoodie-server from a plugin

	A hook is defined as a function that takes a number of arguments
	and possibly a return value. Each hook has its own conventions,
	based on where in hoodie-server it hooks into.

	There are fundamentally two types of hooks:
	- static hooks (see static.js)
	- dynamic hooks (this file)

	The core difference is that static hooks work standalone and just
	receive a number of arguments and maybe return a value. Dynamic
	hooks get initialised with a live instance of the hoodie object,
	that is also available in worker.js, with access to the database,
	and other convenience libraries.
*/
var Stripe = require('stripe');
var chromelogger = require('chromelogger');

var webhooksRequestHandler = require('./handlers/webhooksRequest');
var customersRetrieveHandler = require('./handlers/customersRetrieve');
var customersUpdateHandler = require('./handlers/customersUpdate');
var invoicesRetrieveUpcomingHandler =
	require('./handlers/invoicesRetrieveUpcoming');

var chrome;

var handlers = {
	'invoices.retrieveUpcoming': invoicesRetrieveUpcomingHandler,
	'customers.retrieve': customersRetrieveHandler,
	'customers.create': customersUpdateHandler,
	'customers.update': customersUpdateHandler,
	'customers.updateSubscription': customersUpdateHandler,
};

module.exports = function( hoodie ) {
	return {
		/*
			group: server.api.*
			description: The server.api group allows you to extend the
				/_api endpoint from hoodie-server.
		*/
		/*
			name: server.api.plugin-request
			description: This hook handles any request to
				`/_api/_plugins/{pluginname}/_api`.
				(omitting the hoodie-plugin- prefix in the plugin name)
				It gets the regular hapi request & reply objects as parameters.
				See http://hapijs.com/api#request-object
				and http://hapijs.com/api#reply-interface
				for details.

			parameters:
			- request: the hapi request object
			- reply: the hapi reply object

			return value: boolen
				false determines that the hook didn’t run successfully and
				cuses Hoodie to return a 500 error.
		*/
		'server.api.plugin-request': function routeRequests(request, reply) {
			hoodie.config.get('stripeDebug') ?
				chromelogger.middleware( null, request.raw.res ) :
				request.raw.res.chrome = chrome;

			var context = {
				hoodie: hoodie,
				request: request,
				reply: reply,
				log: request.raw.res.chrome.log,
				method: request.payload && request.payload.method,
				args: request.payload && request.payload.args,
				userDoc: {},
			};

			if ( hoodie.config.get('stripeKey') ) {
				context.stripe = Stripe( hoodie.config.get('stripeKey') );
			}

			if ( context.method ) {
				handlers[ context.method ]( context );
			}
			else {
				webhooksRequestHandler( hoodie, request, reply );
			}
		},
		// We used to have 'plugin.user.confirm' hook here, but it's not very
		// convenient because user confirmation happens in the background.
		// This means there's no error reporting and other customer requests
		// might arrive before the stripe user is properly created or
		// before its userDoc is updated.
	};
};

/* eslint-disable no-console */
chrome = {
	log: console.log.bind(console),
	warn: console.log.bind(console),
	error: console.log.bind(console),
	info: console.log.bind(console),
	table: console.log.bind(console),
	assert: console.log.bind(console),
	count: console.log.bind(console),
	time: console.log.bind(console),
	timeEnd: console.log.bind(console),
	group: console.log.bind(console),
	groupEnd: console.log.bind(console),
	groupCollapsed: console.log.bind(console),
};
