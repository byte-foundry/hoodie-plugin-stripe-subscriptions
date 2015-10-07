module.exports = function handlePingRequest( hoodie, request, reply ) {
	reply(
		null, ( request.payload && request.payload.data ) || { pong: true } );
};
