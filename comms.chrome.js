/* Communication module for cross-extension messaging */
var comms = function(app, ext, stateChange) {

	// The ID of the two apps
	var ids = {
		"app": app,
		"ext": ext
	};
	
	// My extension ID
	var me = false;
	
	// Stores the target app ID
	var them = false;
	
	// The version of the current extension
	var version = false;
	
	// The port for outgoing comms
	var sendPort = false;
	
	// Listeners for when messages are received on channels
	var listeners = {};
	
	// Object with callbacks for the responses to messages that request them
	var callbacks = {};
	
	// A queue of unclaimed received messages
	var unclaimedQueue = [];
	
	// A queue of unsent messages to be sent when a connection is obtained
	var unsentQueue = [];
	
	// Whether or not the disconnect callback has been sent
	var state = "disconnected";
	
	// Heartbeat interval and timer
	var heartbeat = {
		"interval": false,
		"timeout": false
	};
	
	// Whether has been setup yet
	var setuped = false;
	
	// Sends a state change to the client
	function sendStateChange(newState, reason) {
		if (heartbeat.timeout) {
			clearTimeout(heartbeat.timeout);
			heartbeat.timeout = false;
		}
		if (state != newState) {
			stateChange(newState, reason);
			state = newState;
		}
	};
	
	// Setup function which is initially called
	function setup() {
	
		if (setuped) {
			console.info("Comms has already been setup");
			return;
		}
		setuped = true;
	
		// Configure the version and id of the messaging
		var data = chrome.runtime.getManifest();
		version = data.version;
		
		me = chrome.i18n.getMessage("@@extension_id");
	
		// Setup the "them" to target the other app
		if (ids.app == me) {
			them = ids.ext;
		} else if (ids.ext == me) {
			them = ids.app;
		} else {
			console.error("Unable to setup comms. My app ID is not one of the valid app IDs.", me, ids);
			return;
		}
	
		// Configure listeners and senders
		configureListener();
		configureSender();
		
		// Configure heartbeats
		heartbeat.interval = setInterval(function() {
			sendInternalMessage({ "heartbeat": true });
			if (heartbeat.timeout) {
				clearTimeout(heartbeat.timeout);
			}
			heartbeat.timeout = setTimeout(function() {
				sendStateChange("disconnected", "Heartbeat failure");
			}, 1500);
		}, 1000);
	};
	
	// Configures the sender for sending future messages
	function configureSender() {
		if (!them) {
			console.error("Unable to configure sender, 'them' is not specified", them);
			return;
		}
		sendPort = chrome.runtime.connect(them);
		sendStateChange("connected", "Connected");
		sendPort.onDisconnect.addListener(function(event) {
			sendStateChange("disconnected", "Port disconnected");
		});
		sendPort.onMessage.addListener(listener);
	};
	
	// Creates the listener and binds it to the port
	function configureListener() {
		if (!them) {
			console.error("Unable to configure listener, 'them' is not specified", them);
			return;
		}
		chrome.runtime.onConnectExternal.addListener(function(port) {
			port.onMessage.addListener(listener);
			
			// We have a new connection, so check to recover from a disconnect
			if (state != "connected") {
				sendPort = port;
			}
			
			sendStateChange("connected", "External connect");
		});
	};
	
	// Factories a callback method for a specific message
	function callbackFactory(message) {
		return (function(internalChannel, internalResponseId) {
			return function(data, callback) {
				doSend(internalChannel, data, callback, internalResponseId, false);
			};
		})(message.meta.channel, message.meta.ids.query);
	};
	
	// The listener function which receives messages
	function listener(message) {
	
		// Check the version number is valid
		if (message.meta.version != version) {
			console.error("Message received with conflicting version, discarding", version, message.meta.version, message);
			return;
		}
		
		// Add the received time
		message.meta.timing.received = new Date().getTime();
		
		// Deserialise the data
		message.data = JSON.parse(message.data);
	
		// Create the response callback
		var respond = callbackFactory(message);
		
		// Handle internal messages
		if (message.meta.internal) {
			handleInternalMessage(message.data, message.meta);
			return;
		}
	
		// Dispatch the message to all of the callback handlers, if any
		var rid = message.meta.ids.response;
		var callbackValid = false;
		if (rid) {
			if (callbacks.hasOwnProperty(rid)) {
				try {
					callbacks[rid](message.data, respond);
					callbackValid = true;
				} catch (e) {
					console.error("Listener", rid, "caused an exception", e);
				} finally {
					delete callbacks[rid];
				}
			}
		}
	
		// Dispatch the message to all of the channel handlers, if no callback handler found
		if (!callbackValid) {
			var channel = message.meta.channel;
			if (channel && listeners.hasOwnProperty(channel)) {
				var ls = listeners[channel];
				for (var i = 0; i < ls.length; i++) {
					try {
						ls[i](message.data, respond);
					} catch (e) {
						console.error("Listener", i, "on channel", channel, "caused an exception", e);
					}
				}
			} else {
				// The listener does not exist, so queue the message to be tried to deliver later
				// Unshift on to the front to make it easier to deal with later
				unclaimedQueue.unshift(message);
				
				// Trim the queue to stop it taking up absurd amounts of memory
				// Remember it's in reverse chronological order, so this keeps the messages most recently received
				unclaimedQueue.splice(1000);
			}
		}
	};
	
	// Internal method for sending a message
	function doSend(channel, data, callback, reply, internal) {
	
		// Error if the channel is not a string
		if (!verifyChannel(channel)) {
			return;
		}
		
		// If data is an object, stringify it
		if (typeof data == "object") {
			data = JSON.stringify(data);
		}
		
		// Construct the message to send
		var msg = {
			"meta": {
				"internal": internal,
				"channel": channel,
				"version": version,
				"ids": {
					"query": jQuery.fn.random(),
					"response": reply
				},
				"timing": {
					"sent": new Date().getTime(),
					"received": false
				}
			},
			"data": data
		};
		
		// Check that the port is available, only for non-internal messages
		if (state != "connected" && !internal) {
			console.info("Message port is not available, queueing message", msg);
			unsentQueue.push([msg, callback]);
			return;
		}
		
		// If we have a valid send port then get rid of the queue
		if (state == "connected") {
			var unsentItem;
			while (unsentItem = unsentQueue.shift()) {
				sendMessage.apply(this, unsentItem);
			}
		}
		
		// Now send this message
		sendMessage(msg, callback);
	};
	
	// Actually sends a message, assumes port is available
	function sendMessage(msg, callback) {
		if (callback) {
			callbacks[msg.meta.ids.query] = callback;
		}
		try {
			sendPort.postMessage(msg);
		} catch (e) {
			console.error("Unable to send message, port not available", msg, e);
			sendStateChange("disconnected", "Failed to send message");
		}
	};
	
	// Message handler for internal messages
	function handleInternalMessage(message, meta) {
		if (message.hasOwnProperty("heartbeat")) {
			sendStateChange("connected", "Heartbeat received");
		}
	};
	
	// Helper to send an internal message
	function sendInternalMessage(data) {
		doSend("internal", data, false, false, true);
	};
	
	// Verifies that a channel name is appropriate
	function verifyChannel(channel) {
		if (typeof channel != "string") {
			console.error("Cannot send message, channel is not a string", channel);
			return false;
		}
		return true;
	};
	
	/*********
	* Public
	*********/
	
	// Adds a listener for a specific channel from the other extension
	function addListener(channel, callback) {
	
		// Verify the channel name
		if (!verifyChannel(channel)) {
			return;
		}
	
		// The listeners are an array, initialse the array
		if (!listeners.hasOwnProperty(channel)) {
			listeners[channel] = [];
		}
		
		// Add the listener
		listeners[channel].push(callback);
		
		// Now, go through the unclaimed queue, and claim any that this listener wants
		var len = unclaimedQueue.length;
		while (len--) {
			if (unclaimedQueue[len].meta.channel == channel) {
				var message = unclaimedQueue.splice(len, 1)[0];
				callback(message.data, callbackFactory(message));
			}
		}
		
	};
	
	// Sends a message to the other extension
	function send(channel, data, callback) {
		return doSend(channel, data, callback, false, false);
	};
	
	// Call the setup function
	setup();
	
	return {
		"addListener": addListener,
		"send": send
	};
	
};