var Promise = require('bluebird');
var utils = require('../../lib/utils');
var _ = require('lodash');

module.exports = function usernamesExistHandler( context ) {
	return Promise.resolve()
		.then(_.partial(utils.hoodie.usernameExist, context))
		.then(function() {
			context.reply( null, context.isExisting );
		})
		.catch(_.partial(utils.replyError, context));
};
