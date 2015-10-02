var XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest;

global.jQuery = require('jquery-ajax')({
	location: {
		href: '',
	},
	document: {
		documentElement: { matches: true },
		createElement: function() {
			return {
				setAttribute: function() {},
				appendChild: function() {
					return {};
				},
			};
		},
		createDocumentFragment: function() {
			return {
				appendChild: function() {
					return {
						appendChild: function() {},
						cloneNode: function() {
							return {
								cloneNode: function() {
									return { lastChild: {} };
								},
								lastChild: {},
							};
						},
					};
				},
			};
		},
	},
});
global.Hoodie = require('hoodie');
require('../hoodie.stripe');
global.addEventListener = function() {};

global.jQuery.support.cors = true;
global.jQuery.ajaxSettings.xhr = function() {
	return new XMLHttpRequest();
};

module.exports = function setupHoodie() {
	if ( !process.env.HOODIE_URL ) {
		throw new Error('HOODIE_URL env variable required');
	}

	if ( !global.hoodie ) {
		global.hoodie = new global.Hoodie(process.env.HOODIE_URL);
	}

	return global.hoodie;
};
