/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4,
maxerr: 50, node: true */
/*global */

(function () {
    "use strict";
    
    var domain  = require("domain"),
        os      = require("os"),
        http    = require("http"),
        connect = require("connect");
        
    /**
     * @private
     * @type {Object.<string, http.Server>}
     * A map from root paths to server instances.
     */
    var _servers = {};

    var PATH_KEY_PREFIX = "edge-code-inspect-";
    
    /**
     * @private
     * Removes trailing forward slash for the project root absolute path
     * @param {string} path Absolute path for a server
     * @returns {string}
     */
    function normalizeRootPath(path) {
        return (path && path[path.length - 1] === "/") ? path.slice(0, -1) : path;
    }
    
    /**
     * @private
     * Generates a key based on a server's absolute path
     * @param {string} path Absolute path for a server
     * @returns {string}
     */
    function getPathKey(path) {
        return PATH_KEY_PREFIX + normalizeRootPath(path);
    }
    
    /**
     * @private
     * Helper function to create a new server.
     * @param {string} path The absolute path that should be the document root
     * @param {function(?string, ?httpServer)} cb Callback function that receives
     *    an error (or null if there was no error) and the server (or null if there
     *    was an error). 
     */
    function _createServer(path, createCompleteCallback) {
        
        function getExternalAddresses() {
            var interfaces = os.networkInterfaces();
            var addresses = [];

            Object.keys(interfaces).forEach(function (k) {
                interfaces[k].forEach(function (addr) {
                    if (addr.family === "IPv4" && !addr.internal) {
                        var octets = addr.address.split(".");
                        if (octets[0] !== "169" && octets[1] !== "254") {
                            addresses.push(addr.address);
                        }
                    }
                });
            });
        
            return addresses;
        }
        
        function requestRoot(server, host, cb) {
            // Request the root file from the project in order to ensure that the
            // server is actually initialized. If we don't do this, it seems like
            // connect takes time to warm up the server.
            var req = http.get(
                {host: host, port: server.address().port},
                function (res) {
                    cb(null, res);
                }
            );
            req.on("error", function (err) {
                cb(err, null);
            });
        }
        
        function rejectOffSubnetRequests(serverAddress) {
            var serverAddressOctets = serverAddress.split(".");
            
            return function (request, response, next) {
                var clientAddress = request.connection.remoteAddress;
                
                if (clientAddress) {
                    var clientAddressOctets = clientAddress.split(".");
                    
                    if (clientAddressOctets[0] === serverAddressOctets[0] &&
                            clientAddressOctets[1] === serverAddressOctets[1] &&
                            clientAddressOctets[2] === serverAddressOctets[2]) {
                        return next();
                    }
                }
                
                console.log("Rejecting off-subnet request from address: " + clientAddress);
                response.statusCode = 403;
                response.end("Forbidden");
            };
        }
         
        var externalAddresses = getExternalAddresses();
        
        if (externalAddresses.length === 0) {
            createCompleteCallback("Could not find an external IP address", null, null);
        } else {
            var host    = externalAddresses[0],
                app     = connect(),
                server;

            app.use(rejectOffSubnetRequests(host));
            app.use(connect["static"](path));
            app.use(connect.limit("1mb"));
            
            server = http.createServer(app);
            server.listen(0, function () {
                requestRoot(server, host,
                    function (err, res) {
                        if (err) {
                            createCompleteCallback("Could not GET root after launching server", null, null);
                        } else {
                            createCompleteCallback(null, server, {address: host,
                                                                  port: server.address().port});
                        }
                    });
            });
        }
    }
    
    /**
     * @private
     * Handler function for the staticServer.getServer command. If a server
     * already exists for the given path, returns that, otherwise starts a new
     * one.
     * @param {string} path The absolute path that should be the document root
     * @param {function(?string, ?{address: string, family: string,
     *    port: number})} cb Callback that should receive the address information
     *    for the server. First argument is the error string (or null if no error),
     *    second argument is the address object (or null if there was an error).
     *    The "family" property of the address indicates whether the address is,
     *    for example, IPv4, IPv6, or a UNIX socket.
     */
    function _cmdGetServer(path, cb) {
        // Make sure the key doesn't conflict with some built-in property of Object.
        var pathKey = getPathKey(path);
        if (_servers[pathKey]) {
            cb(null, _servers[pathKey].address);
        } else {
            _createServer(path, function (err, server, address) {
                if (err) {
                    cb(err, null);
                } else {
                    _servers[pathKey] = {server: server, address: address};
                    cb(null, address);
                }
            });
        }
    }
    
    /**
     * @private
     * Handler function for the staticServer.closeServer command. If a server
     * exists for the given path, closes it, otherwise does nothing. Note that
     * this function doesn't wait for the actual socket to close, since the
     * server will actually wait for all client connections to close (which can
     * be awhile); but once it returns, you're guaranteed to get a different
     * server the next time you call getServer() on the same path.
     *
     * @param {string} path The absolute path whose server we should close.
     * @return {boolean} true if there was a server for that path, false otherwise
     */
    function _cmdCloseServer(path, cba) {
        var pathKey = getPathKey(path);
        if (_servers[pathKey]) {
            var serverToClose = _servers[pathKey].server;
            delete _servers[pathKey];
            serverToClose.close(function () {
                cba(null, path);
            });
        } else {
            cba(path);
        }
    }

    /**
     * Initializes the StaticServer domain with its commands.
     * @param {DomainManager} domainManager The DomainManager for the server
     */
    function init(domainManager) {
        var _domainManager  = domainManager,
            inspectDomain   = domain.create();
        
        inspectDomain.on("error", function (err) {
            console.log("InspectHTTPDomain error: " + err);
        });
        
        if (!domainManager.hasDomain("inspectHttpServer")) {
            domainManager.registerDomain("inspectHttpServer", {major: 0, minor: 1});
        }
        _domainManager.registerCommand(
            "inspectHttpServer",
            "getServer",
            inspectDomain.bind(_cmdGetServer),
            true,
            "Starts or returns an existing server for the given path.",
            [{
                name: "path",
                type: "string",
                description: "absolute filesystem path for root of server"
            }],
            [{
                name: "address",
                type: "{address: string, family: string, port: number}",
                description: "hostname (stored in 'address' parameter), port, and socket type (stored in 'family' parameter) for the server. Currently, 'family' will always be 'IPv4'."
            }]
        );
        _domainManager.registerCommand(
            "inspectHttpServer",
            "closeServer",
            inspectDomain.bind(_cmdCloseServer),
            true,
            "Closes the server for the given path.",
            [{
                name: "path",
                type: "string",
                description: "absolute filesystem path for root of server"
            }],
            [{
                name: "result",
                type: "boolean",
                description: "indicates whether a server was found for the specific path then closed"
            }]
        );
    }
    
    exports.init = init;
    
}());
