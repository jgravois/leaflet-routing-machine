/*
to do:
decode compressed geometry to make individual turn geometries interactive
make it work with nominatim geocoder
expose a few routing parameters
isolate the provider in its own repo
*/
(function() {
	'use strict';

	var L = require('leaflet');
	var corslite = require('corslite');
	var polyline = require('polyline');
	// osrmTextInstructions = require('osrm-text-instructions');

	// Ignore camelcase naming for this file, since OSRM's API uses
	// underscores.
	/* jshint camelcase: false */
	var Waypoint = require('../waypoint');

	/**
	 * Works against OSRM's new API in version 5.0; this has
	 * the API version v1.
	 */
	module.exports = L.Class.extend({
		options: {
			// proxied url hits an esri routing service without a token
			// doc says directionsLengthUnits is km by default, but its really miles
			serviceUrl: 'http://utility.arcgis.com/usrsvcs/appservices/rdcfU1A3eVNshs0d/rest/services/World/Route/NAServer/Route_World',
			// profile: 'driving',
			timeout: 30 * 1000
			// routingOptions: {
			// 	alternatives: true,
			// 	steps: true
			// },
			// polylinePrecision: 5,
			// useHints: true,
			// language: 'en'
		},

		initialize: function(options) {
			L.Util.setOptions(this, options);
			this._hints = {
				locations: {}
			};
		},

		route: function(waypoints, callback, context, options) {
			var timedOut = false,
				wps = [],
				url,
				timer,
				wp,
				i,
				xhr;

			options = L.extend({}, this.options.routingOptions, options);
			url = this.buildRouteUrl(waypoints, options);
			if (this.options.requestParameters) {
				url += L.Util.getParamString(this.options.requestParameters, url);
			}

			timer = setTimeout(function() {
				timedOut = true;
				callback.call(context || callback, {
					status: -1,
					message: 'OSRM request timed out.'
				});
			}, this.options.timeout);

			// Create a copy of the waypoints, since they
			// might otherwise be asynchronously modified while
			// the request is being processed.
			for (i = 0; i < waypoints.length; i++) {
				wp = waypoints[i];
				wps.push(new Waypoint(wp.latLng, wp.name, wp.options));
			}

			return xhr = corslite(url, L.bind(function(err, resp) {
				var data,
					error =  {};

				clearTimeout(timer);
				if (!timedOut) {
					if (!err) {
						try {
							data = JSON.parse(resp.responseText);
							try {
								return this._routeDone(data, wps, options, callback, context);
							} catch (ex) {
								error.status = -3;
								error.message = ex.toString();
							}
						} catch (ex) {
							error.status = -2;
							error.message = 'Error parsing OSRM response: ' + ex.toString();
						}
					} else {
						error.message = 'HTTP request failed: ' + err.type +
							(err.target && err.target.status ? ' HTTP ' + err.target.status + ': ' + err.target.statusText : '');
						error.url = url;
						error.status = -1;
						error.target = err;
					}

					callback.call(context || callback, error);
				} else {
					xhr.abort();
				}
			}, this));
		},

		requiresMoreDetail: function(route, zoom, bounds) {
			if (!route.properties.isSimplified) {
				return false;
			}

			var waypoints = route.inputWaypoints,
				i;
			for (i = 0; i < waypoints.length; ++i) {
				if (!bounds.contains(waypoints[i].latLng)) {
					return true;
				}
			}

			return false;
		},

		_routeDone: function(response, inputWaypoints, options, callback, context) {
			var alts = [],
			    actualWaypoints,
			    i,
			    route;

			context = context || callback;
			// no error message
			if (response.messages.length > 0) {
				callback.call(context, {
					status: response.code
				});
				return;
			}

			// actualWaypoints = this._toWaypoints(inputWaypoints, response.waypoints);

			// can the esri service pass back alternate routes? if so, add a loop
			route = this._convertRoute(response.directions[0]);

			route.summary = {
				totalDistance: response.directions[0].summary.totalLength,
				// seconds
				totalTime: response.directions[0].summary.totalTime * 60
			}

			route.name = 'Esri routing service!'
			response.routes.features[0]
			route.inputWaypoints = inputWaypoints;
			route.waypoints = inputWaypoints; // actualWaypoints;
			// what does this do?
			route.properties = {isSimplified: !options || !options.geometryOnly || options.simplifyGeometry};

			route.coordinates = [];

			for (var j=0; j < response.routes.features[0].geometry.paths[0].length; j++) {
				var currentPair = response.routes.features[0].geometry.paths[0][j];
				route.coordinates.push(L.latLng([currentPair[1], currentPair[0]]));
			}

			route.waypointIndices = [
				0, (response.routes.features[0].geometry.paths[0].length - 1)
			]

			alts.push(route);

			this._saveHintData(inputWaypoints, inputWaypoints);

			// each route in array has
			// a name - done
			// summary of time and distance - done
			// instructions object (with turn by turn) - done, but finished text will need parsed differently
			// waypoints - done (passing input for now)
			// waypointIndices array - done (first and last only for now)
			// array of coordinates (whole route)

			callback.call(context, null, alts);
		},

		_convertRoute: function(responseRoute, summary) {
			var result = {
					// coordinates: [],
					instructions: []
				},
				legNames = [],
				waypointIndices = [],
				index = 0,
				legCount = 1, // responseRoute.features.length,
				hasSteps = responseRoute.features.length > 0,
				i,
				j,
				leg,
				step,
				geometry,
				type,
				modifier,
				text,
				stepToText;

			for (i = 0; i < legCount; i++) {
				leg = responseRoute.features;
				legNames.push(responseRoute.routeName);
				// geometry = this._decodePolyline(leg.compressedGeometry);
				text = responseRoute.routeName;

				for (j = 0; j < leg.length; j++) {
					step = leg[j];
					geometry = this._decodePolyline(step.compressedGeometry);
					// result.coordinates.push.apply(result.coordinates, geometry);
					type = this._esriManeuverToInstructionType(step.attributes, i === legCount - 1);
					modifier = this._esriManeuverToModifier(step.attributes);
					// text = stepToText(step);
					text = step.attributes.text;

					// if (j == 0 || j == leg.length - 1) {
					// 	waypointIndices.push(index);
					// }

						result.instructions.push({
							type: type,
							distance: step.attributes.length,
							time: step.attributes.time,
							// road: 'placeholder', // step.name,
							// direction: this._bearingToDirection(step.maneuver.bearing_after),
							// exit: step.maneuver.exit,
							// index: index,
							// mode: step.mode,
							modifier: modifier,
							text: text
						});

					// if (type) {
					// 	if ((i == 0 && step.maneuver.type == 'depart') || step.maneuver.type == 'arrive') {
					// 		waypointIndices.push(index);
					// 	}
					//
					// 	result.instructions.push({
					// 		type: type,
					// 		distance: step.distance,
					// 		time: step.duration,
					// 		road: step.name,
					// 		direction: this._bearingToDirection(step.maneuver.bearing_after),
					// 		exit: step.maneuver.exit,
					// 		index: index,
					// 		mode: step.mode,
					// 		modifier: modifier,
					// 		text: text
					// 	});
					// }

					index += geometry.length;
				}
			}

			result.name = legNames.join(', ');
			if (!hasSteps) {
				result.coordinates = this._decodePolyline(responseRoute.geometry);
			} else {
				// result.waypointIndices = waypointIndices;
			}

			return result;
		},

		_bearingToDirection: function(bearing) {
			var oct = Math.round(bearing / 45) % 8;
			return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][oct];
		},

		_esriManeuverToInstructionType: function(attributes, lastLeg) {
			// case 'esriDMTStraight':
			// case 'esriDMTTurnLeft':
			// case 'esriDMTTurnRight':
			switch (attributes.maneuverType) {
			case 'esriDMTDepart':
				return 'Head';
			case 'esriDMTStop':
				return lastLeg ? 'DestinationReached' : 'WaypointReached';
			case 'esriDMTRoundabout':
			case 'rotary':
				return 'Roundabout';
			case 'esriDMTForkLeft':
			case 'esriDMTForkRight':
			case 'esriDMTRampLeft':
			case 'esriDMTRampRight':
			case 'esriDMTSharpLeft':
			case 'esriDMTSharpRight':
				return this._camelCase(attributes.maneuverType);
			// These are all reduced to the same instruction in the current model
			//case 'turn':
			//case 'ramp': // deprecated in v5.1
			default:
				return null // this._camelCase(attributes.modifier);
			}
		},

		_esriManeuverToModifier: function(attributes) {
			var modifier ; // = attributes.modifier;
			// modifier = this._leftOrRight(attributes.maneuverType);

			switch (attributes.maneuverType) {
			case 'esriDMTDepart':
			case 'esriDMTStraight':
			case 'esriDMTRoundabout':
			case 'esriDMTStop':
			  modifier = null;
				break
			// case 'esriDMTTurnLeft':
			// case 'esriDMTTurnRight':
			// case 'esriDMTForkLeft':
			// case 'esriDMTForkRight':
			// case 'esriDMTRampLeft':
			// case 'esriDMTRampRight':
			// case 'esriDMTSharpLeft':
			// case 'esriDMTSharpRight':
			default:
			  modifier = this._leftOrRight(attributes.maneuverType);
			}
			return modifier && this._camelCase(modifier);
		},

		_camelCase: function(s) {
			var words = s.split(' '),
				result = '';
			for (var i = 0, l = words.length; i < l; i++) {
				result += words[i].charAt(0).toUpperCase() + words[i].substring(1);
			}

			return result;
		},

		_leftOrRight: function(d) {
			return d.indexOf('Left') >= 0 ? 'Left' : 'Right';
		},

		_decodePolyline: function(routeGeometry) {
			var cs = polyline.decode(routeGeometry, this.options.polylinePrecision),
				result = new Array(cs.length),
				i;
			for (i = cs.length - 1; i >= 0; i--) {
				result[i] = L.latLng(cs[i]);
			}

			return result;
		},

		_toWaypoints: function(inputWaypoints, vias) {
			var wps = [],
			    i,
			    viaLoc;
			for (i = 0; i < vias.length; i++) {
				viaLoc = vias[i].location;
				wps.push(new Waypoint(L.latLng(viaLoc[1], viaLoc[0]),
				                            inputWaypoints[i].name,
											inputWaypoints[i].options));
			}

			return wps;
		},

		buildRouteUrl: function(waypoints, options) {
			var locs = [],
				hints = [],
				wp,
				latLng,
			    computeInstructions,
			    computeAlternative = true;

			for (var i = 0; i < waypoints.length; i++) {
				wp = waypoints[i];
				latLng = wp.latLng;
				locs.push(latLng.lng + ',' + latLng.lat);
				hints.push(this._hints.locations[this._locationKey(latLng)] || '');
			}

			computeInstructions =
				true;
				// to do: expose more routing parameters!
				new Date().getTime()
				return this.options.serviceUrl + '/solve?f=json&directionsLengthUnits=esriNAUMeters&directionsOutputType=esriDOTComplete&startTimeisUTC=true&startTime=' + new Date().getTime() + '&stops=' +
					locs.join(';');
		},

		_locationKey: function(location) {
			return location.lat + ',' + location.lng;
		},

		_saveHintData: function(actualWaypoints, waypoints) {
			var loc;
			this._hints = {
				locations: {}
			};
			for (var i = actualWaypoints.length - 1; i >= 0; i--) {
				loc = waypoints[i].latLng;
				this._hints.locations[this._locationKey(loc)] = actualWaypoints[i].hint;
			}
		},
	});
})();
