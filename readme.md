# comms.chrome.js

Communicate between two Chrome apps or extensions

## Dependencies

- [jQuery](http://jquery.com/download/)
- [random.jquery.js](https://github.com/chrisalexander/random.jquery.js)

## Setup

Both of the apps should do this:

    var c = new comms(appId1, appId2, function(state, reason) {
	    console.log("State of connection changed", state, reason);
	});
	
## Adding listener

To add a listener for messages from the other app or extension on a specific channel name.

Note the second argument is a function to which you can respond straight away. This will call the response callback of the message sender, if there is one.

    c.addListener("channelName", function(message, respond) {
		console.log("Message on channelName", message);
		respond({ "data": "This is my response" });
	});
	
## Sending a message

Send a message on a specific channel with an object of data.

The third argument, the callback, is what is called when the listener calls the respond function. Note you also have a respond function - this can keep going backwards and forwards as much as you like.

    c.send("channelName", { "data": "here" }, function(message, respond) {
		console.log("Response received", message);
		respond({ "respond": "again" });
	});
	
# License

[MIT license](http://opensource.org/licenses/MIT)