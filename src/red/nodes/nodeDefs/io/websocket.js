module.exports = function(RED) {
  "use strict";
  var ws = require("ws");
  var inspect = require("util").inspect;

  // A node red node that sets up a local websocket server
  function WebSocketListenerNode(n) {
    // Create a RED node
    RED.nodes.createNode(this,n);
    var node = this;

    // Store local copies of the node configuration (as defined in the .html)
    node.path = n.path;
    node.wholemsg = (n.wholemsg === "true");

    node._inputNodes = [];    // collection of nodes that want to receive events
    node._clients = {};
    // match absolute url
    node.isServer = !/^ws{1,2}:\/\//i.test(node.path);
    node.closing = false;

    function startconn() {    // Connect to remote endpoint
      var socket = new ws(node.path);
      node.server = socket; // keep for closing
      handleConnection(socket);
    }

    function handleConnection(socket) {
      var id = (1+Math.random()*4294967295).toString(16);
      if (node.isServer) { node._clients[id] = socket; node.emit('opened',Object.keys(node._clients).length); }
      socket.on('open',function() {
        if (!node.isServer) { node.emit('opened',''); }
      });
      socket.on('close',function() {
        if (node.isServer) { delete node._clients[id]; node.emit('closed',Object.keys(node._clients).length); }
        else { node.emit('closed'); }
        if (!node.closing && !node.isServer) {
          node.tout = setTimeout(function(){ startconn(); }, 3000); // try to reconnect every 3 secs... bit fast ?
        }
      });
      socket.on('message',function(data,flags){
        node.handleEvent(id,socket,'message',data,flags);
      });
      socket.on('error', function(err) {
        node.emit('erro');
        if (!node.closing && !node.isServer) {
          node.tout = setTimeout(function(){ startconn(); }, 3000); // try to reconnect every 3 secs... bit fast ?
        }
      });
    }

    if (node.isServer) {
      var path = RED.settings.httpNodeRoot || "/";
      path = path + (path.slice(-1) == "/" ? "":"/") + (node.path.charAt(0) == "/" ? node.path.substring(1) : node.path);

      // Workaround https://github.com/einaros/ws/pull/253
      // Listen for 'newListener' events from RED.server
      node._serverListeners = {};

      var storeListener = function(event, listener){
        if(event == "error" || event == "upgrade" || event == "listening"){
          node._serverListeners[event] = listener;
        }
      }

      RED.server.addListener('newListener',storeListener);

      // Create a WebSocket Server
      node.server = new ws.Server({server:RED.server,path:path});

      // Workaround https://github.com/einaros/ws/pull/253
      // Stop listening for new listener events
      RED.server.removeListener('newListener',storeListener);

      node.server.on('connection', handleConnection);
    }
    else {
      node.closing = false;
      startconn(); // start outbound connection
    }

    node.on("close", function() {
      // Workaround https://github.com/einaros/ws/pull/253
      // Remove listeners from RED.server
      if (node.isServer) {
        var listener = null;
        for (var event in node._serverListeners) {
          if (node._serverListeners.hasOwnProperty(event)) {
            listener = node._serverListeners[event];
            if (typeof listener === "function") {
              RED.server.removeListener(event,listener);
            }
          }
        }
        node._serverListeners = {};
        node.server.close();
        node._inputNodes = [];
      }
      else {
        node.closing = true;
        node.server.close();
        if (node.tout) { clearTimeout(node.tout); }
      }
    });
  }
  RED.nodes.registerType("websocket-listener",WebSocketListenerNode);
  RED.nodes.registerType("websocket-client",WebSocketListenerNode);

  WebSocketListenerNode.prototype.registerInputNode = function(handler) {
    this._inputNodes.push(handler);
  }

  WebSocketListenerNode.prototype.removeInputNode = function(handler) {
    this._inputNodes.forEach(function(node, i, inputNodes) {
      if (node === handler) {
        inputNodes.splice(i, 1);
      }
    });
  }

  WebSocketListenerNode.prototype.handleEvent = function(id, socket, event, data, flags){
    var msg;
    if (this.wholemsg) {
      try {
        msg = JSON.parse(data);
      }
      catch(err) {
        msg = { payload:data };
      }
    } else {
      msg = {
        payload:data
      };
    }
    msg._session = {type:"websocket",id:id};
    for (var i = 0; i < this._inputNodes.length; i++) {
      this._inputNodes[i].send(msg);
    }
  }

  WebSocketListenerNode.prototype.broadcast = function(data) {
    try {
      if(this.isServer) {
        for (var i = 0; i < this.server.clients.length; i++) {
          this.server.clients[i].send(data);
        }
      }
      else {
        this.server.send(data);
      }
    }
    catch(e) { // swallow any errors
      this.warn("ws:"+i+" : "+e);
    }
  }

  WebSocketListenerNode.prototype.reply = function(id,data) {
    var session = this._clients[id];
    if (session) {
      try {
        session.send(data);
      }
      catch(e) { // swallow any errors
      }
    }
  }

  function WebSocketInNode(n) {
    RED.nodes.createNode(this,n);
    this.server = (n.client)?n.client:n.server;
    var node = this;
    this.serverConfig = RED.nodes.getNode(this.server);
    if (this.serverConfig) {
      this.serverConfig.registerInputNode(this);
      this.serverConfig.on('opened', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
      this.serverConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
      this.serverConfig.on('closed', function() { node.status({fill:"red",shape:"ring",text:"disconnected"}); });
    } else {
      this.error(RED._("websocket.errors.missing-conf"));
    }

    this.on('close', function() {
      node.serverConfig.removeInputNode(node);
    });

  }
  RED.nodes.registerType("websocket in",WebSocketInNode);

  function WebSocketOutNode(n) {
    RED.nodes.createNode(this,n);
    var node = this;
    this.server = (n.client)?n.client:n.server;
    this.serverConfig = RED.nodes.getNode(this.server);
    if (!this.serverConfig) {
      this.error(RED._("websocket.errors.missing-conf"));
    }
    else {
      this.serverConfig.on('opened', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
      this.serverConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
      this.serverConfig.on('closed', function() { node.status({fill:"red",shape:"ring",text:"disconnected"}); });
    }
    this.on("input", function(msg) {
      var payload;
      if (this.serverConfig.wholemsg) {
        delete msg._session;
        payload = JSON.stringify(msg);
      } else if (msg.hasOwnProperty("payload")) {
        if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
          payload = RED.util.ensureString(msg.payload);
        }
        else {
          payload = msg.payload;
        }
      }
      if (payload) {
        if (msg._session && msg._session.type == "websocket") {
          node.serverConfig.reply(msg._session.id,payload);
        } else {
          node.serverConfig.broadcast(payload,function(error){
            if (!!error) {
              node.warn(RED._("websocket.errors.send-error")+inspect(error));
            }
          });
        }
      }
    });
  }
  RED.nodes.registerType("websocket out",WebSocketOutNode);
}

