/*
 * Copyright 2017 Scott Bender (scott@scottbender.net)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const Alexa = require('alexa-sdk');
const awsSDK = require('aws-sdk');
var request = require('request');
var _ = require('lodash')

const docClient = new awsSDK.DynamoDB.DocumentClient();
const usersTable = 'signalk_alexa_users'

const APP_ID = undefined;  // TODO replace with your app ID (OPTIONAL).

const languageStrings = {
  'en': {
    translation: {
      SKILL_NAME: 'Signal K',
      WELCOME_MESSAGE: "Welcome to %s. You can ask a question like, what\'s the wind speed? ... Now, what can I help you with?",
      WELCOME_REPROMPT: 'For instructions on what you can say, please say help me.',
      STOP_MESSAGE: 'Thanks for using SignalK',
      DISPLAY_CARD_TITLE: '%s  - Recipe for %s.',
      HELP_MESSAGE: "You can ask questions such as, what\'s the battery voltage, or, you can say exit...Now, what can I help you with?",
      HELP_REPROMPT: "You can say things like, what\'s the battery voltage, or you can say exit...Now, what can I help you with?",
      UNKNOWN_MESSAGE: "I don't know how to get the %s",
      RESPONSE_MESSAGE: "The %s is %s %s",
      TANK_RESPONSE_MESSAGE: "The %s tank level is %s percent",
      BATTERY_RESPONSE_MESSAGE: "The %s battery %s is %s %s",
      BATTERY_SIMPLE_RESPONSE_MESSAGE: "The battery %s is %s %s",
      TANK_NOT_FOUND: "I was unable to find the %s tank level",
      BATTERY_VALUE_NOT_FOUND: "I was unable to find %s for the %s battery",
      BATTERIES_NOT_FOUND: "I was unable to find the %s for any batteries"
    },
  }
}

const unitsDefaults = {
  'speed': 'knots',
  'wind speed': 'knots',
  'temperature': 'fahrenheit',
  'depth': 'feet'
}

function getUnitsSpeech(user, unitsType) {
  if ( !unitsType )
    return ''

  console.log(`${user} ${unitsType}`)
  
  var units = _.get(user, `units.${unitsType}`)
  if ( _.isUndefined(units) ) {
    units = unitsDefaults[unitsType]
  }
  console.log(`units ${units}`)
  if ( !units )
    return ''
  if ( unitsType == 'temperature' )
    units = `degrees ${units}`
  console.log(`units res ${units}`)
  return units
}

function getUnitsPreference(user, unitsType) {
  return _.get(user, `units.${unitsType}`) || unitsDefaults[unitsType]
}

function convertTemperator(value, user) {
  var units = getUnitsPreference(user, 'temperature')
  if ( units == 'celsius' ) {
    return Math.round(Number(value) - 273.15)
  } else {
    return Math.round(Number(value) * (9/5) - 459.67)
  }
}
  
function convertSpeed(value, user, unitsType) {
  var units = getUnitsPreference(user, unitsType || 'speed')
  value = Number(value)
  if ( units == 'meeters per second' ) {
    return Math.round(value)
  } else if ( units === 'miles per hour' ) {
    return Math.round(value * 2.23694)
  } else if ( units === 'kilometers per hour' ) {
    return precisionRound(value * 3.6, 1)
  } else {
    return Math.round(value * 1.94384)
  }
}

function convertWindSpeed(value, user) {
  return convertSpeed(value, user, 'wind speed')
}

function convertPercent(value) {
  return Math.round(Number(value) * 100)
}

function precisionRound(number, precision) {
  var factor = Math.pow(10, precision);
  return Math.round(number * factor) / factor;
}

function convertVolts(value) {
  return precisionRound(Number(value), 1)
}

function convertAmps(value) {
  return precisionRound(Number(value), 1)
}

function convertDepth(value, user) {
  var units = getUnitsPreference(user, 'depth')
  if ( units === 'meters' ) {
    return precisionRound(Number(value), 1)
  } else {
    return precisionRound(Number(value)*3.28084, 1)
  }
}

const skMappings = {
  'wind speed': {
    path: 'environment.wind.speedApparent.value',
    conversion: convertWindSpeed,
    unitsType: 'wind speed'
  },
  'cabin temperature': {
    path: 'environment.inside.temperature.value',
    conversion: convertTemperator,
    unitsType: 'temperature'
  },
  'water temperature': {
    path: 'environment.water.temperature.value',
    conversion: convertTemperator,
    unitsType: 'temperature'
  },
  'outside temperature': {
    path: 'environment.outside.temperature.value',
    conversion: convertTemperator,
    unitsType: 'temperature'
  },
  'depth below keel': {
    path: 'environment.depth.belowKeel.value',
    conversion: convertDepth,
    unitsType: 'depth'
  },
  'depth below surface': {
    path: 'environment.depth.belowSurface.value',
    conversion: convertDepth,
    unitsType: 'depth'
  },
  'depth below transducer': {
    path: 'environment.depth.belowTransducer.value',
    conversion: convertDepth,
    unitsType: 'depth'
  },
  'speed over ground': {
    path: 'navigation.speedOverGround.value',
    conversion: convertSpeed,
    unitsType: 'speed'
  },
}

skMappings['inside temperature']  = skMappings['cabin temperature']

const baseUrl = `https://cloud.signalk.org/signalk/v1/api/vessels/urn:mrn:imo:mmsi:`
function getBaseURL(mmsi) {
  return `${baseUrl}${mmsi}/`
}

var userToMMSI = {}

const handlers = {
  'LaunchRequest': function () {
    this.attributes.speechOutput = this.t('WELCOME_MESSAGE', this.t('SKILL_NAME'));
    // If the user either does not reply to the welcome message or says something that is not
    // understood, they will be prompted again with this text.
    this.attributes.repromptSpeech = this.t('WELCOME_REPROMPT');
    
    this.response.speak(this.attributes.speechOutput).listen(this.attributes.repromptSpeech);
    this.emit(':responseReady');
  },
  'GetData': function () {
    getUserData(this, (err, user) => {
      if ( err || !user ) {
        return
      }
      
      var speach
      const item = this.event.request.intent.slots.SignalKField.value
      var mapping = skMappings[item]
      
      console.log(`item requested: ${item}`)

      if ( !item ) {
        elicit(this, 'SignalKField', 'What would like to know about your boat?')
        return
      }
      
      if ( !mapping ) {
        if ( item.indexOf('dot') != -1 ) {
          var parts = item.split(' dot ')
          var path = parts.join('.') + '.value'
          mapping = {
            path: path,
            conversion: (value) => value,
          }
        } else if ( item.indexOf(' ') != -1 ) {
          var parts = item.split(' ')
          var path = parts.join('.') + '.value'
          mapping = {
            path: path,
            conversion: (value) => value,
          }
        }
      }
    
      if ( !mapping ) {
        respond(this, this.t('UNKNOWN_MESSAGE', item))
      } else {
        getValue(getBaseURL(user.mmsi), mapping.path, user,
                 (err, value) => {
                   var units = getUnitsSpeech(user, mapping.unitsType)
                   respond(this, this.t('RESPONSE_MESSAGE', item, value, units))
                 },
                 mapping.conversion
                )
      }
    })
  },
  'GetLevel': function () {
    getUserData(this, (err, user) => {
      if ( err || !user ) {
        return
      }
      
      var speach

      var tank = this.event.request.intent.slots.TankType.value

      console.log(`tank: ${tank}`)
      
      var tankKey = tank
      var parts = tank.split(' ')
      if ( parts.length > 1 ) {
        for ( var i = 1; i < parts.length; i++ ) {
          parts[i] = parts[i].charAt(0).toUpperCase() + parts[i].slice(1)
        }
        tankKey = parts.join('')
      } else if ( tankKey.endsWith('water') ) {
        var idx = tankKey.indexOf('water')
        tankKey = tankKey.substring(0, idx) + 'Water'
      }

      tankKey = tankKey.charAt(0).toLowerCase() + tankKey.slice(1)
      getValue(getBaseURL(user.mmsi),
               `tanks.${tankKey}.0.currentLevel.value`,
               user,
               (err, value) => {
                 if ( err || value == null ) {
                   console.log(err)
                   respond(this, this.t('TANK_NOT_FOUND', tank))
                 } else {
                   respond(this, this.t('TANK_RESPONSE_MESSAGE', tank, value))
                 }
               },
               convertPercent
              )
    })
  },
  'GetBattery': function () {
    getUserData(this, (err, user) => {
      if ( err || !user ) {
        return
      }
      var speach

      var name = this.event.request.intent.slots.BatteryName.value
      var batValue = this.event.request.intent.slots.BatteryValue.value
      var valName = batValue

      if ( !batValue ) {
        elicit(this, 'BatteryValue', 'What information would you like to know about your battery? You can say voltage, current or charge.')
        return
      }

      console.log(`name: ${name} ${batValue}`)

      var conv = (value) => value
      var units = ''
      if ( batValue == 'charge' ) {
        batValue = 'capacity.stateOfCharge'
        conv = convertPercent
        units = 'percent'
      } else if ( batValue == 'voltage' ) {
        units = 'volts'
        conv = convertVolts
      } else if ( batValue == 'current' ) {
        units = 'amps'
        conv = convertAmps
      }

      if ( name ) {
        getValue(getBaseURL(user.mmsi), `electrical.batteries.${name}.${batValue}.value`, user, (err, value) => {
          if ( err || value == null ) {
            console.log(err)
            respond(this, this.t('BATTERY_VALUE_NOT_FOUND', valName, name))
          } else {
            respond(this, this.t('BATTERY_RESPONSE_MESSAGE', name, valName, value, units))
          }
        },
                 conv
                )
      } else {
        request(getBaseURL(user.mmsi) + "electrical/batteries",  (error, response, body) => {
          console.log(`response: ${JSON.stringify(response)} ${error}`)
          if ( error ) {
            respond(this, this.t('BATTERIES_NOT_FOUND', valName))
            return
          }
          var parsed = JSON.parse(body)
          var res = {}
          _.keys(parsed).forEach(instance => {
            var p = `${instance}.${batValue}.value`
            var val = _.get(parsed, p)
            if ( !_.isUndefined(val) ) {
              res[instance] = conv(val)
            }
          })

          var len = _.keys(res).length
          if ( len == 0 ) {
            respond(this, this.t('BATTERIES_NOT_FOUND', valName))
          } else {
            var sentence = null
            
            if ( len == 1 ) {
              sentence = this.t('BATTERY_SIMPLE_RESPONSE_MESSAGE',
                                valName, res[_.keys(res)[0]], units)
            } else {
              _.keys(res).forEach(instance => {
                var text = this.t('BATTERY_RESPONSE_MESSAGE', instance, valName,
                                  res[instance], units)
                sentence = sentence != null ? (sentence + ', ' + text) : text
              })
            }
            respond(this, sentence)
          }
        })
      }
    })
  },
  'SetMMSI': function () {
    var mmsi = this.event.request.intent.slots.mmsi.value
    console.log(`SetMMSI ${mmsi}`)
    getValue(getBaseURL(mmsi), "mmsi", null, (err, value) => {
      if ( err ) {
        elicit(this, 'mmsi', `I was unable to find the m m s i ${mmsi} in the Signal K Cloud. Please say your m m s i again.`)
        return
      } else {
        var userId = this.event.session.user.userId
        const params = {
          TableName: usersTable,
          Item: {
            userId: userId,
            mmsi: mmsi
          }
        };

        const getParams = {
          TableName: usersTable,
          Key: {
            userId: userId,
          }
        };
    
        docClient.get(getParams, (err, data) => {
          if ( !err && data && data.Item  ) {
            console.log(`got existing: ${JSON.stringify(data)}`)
            params.Item = data.Item
            params.Item.mmsi = mmsi
          }
      
          console.log(`user ${JSON.stringify(params)}`)
          docClient.put(params, (err, data) => {
            if ( err ) {
              console.log(`put error: ${err}`)
            }
            respond(this, 'Thank you. I will remember your m m s i from now on')
          })
        })
      }
    })
  },
  'WhatIsMyMMSI': function() {
    var userId = this.event.session.user.userId
    const params = {
      TableName: usersTable,
      Key: {
        userId: userId,
      }
    };
    
    docClient.get(params, (err, data) => {
      if ( err || !data || !data.Item  ) {
        respond(this, "I don't know your m m s i yet.")
      } else {
        respond(this, `You're m m s i is ${data.Item.mmsi}`)
      }
    })
  },
  'SetUnits': function() {
    var userId = this.event.session.user.userId
    var unitsVal = this.event.request.intent.slots.units.value
    var unitsTypeVal = this.event.request.intent.slots.unitsType.value

    const params = {
      TableName: usersTable,
      Item: {
        userId: userId,
        units: {
          [unitsTypeVal]: unitsVal
        }
      }
    };

    const getParams = {
      TableName: usersTable,
      Key: {
        userId: userId,
      }
    };
    
    docClient.get(getParams, (err, data) => {
      if ( !err && data && data.Item  ) {
        console.log(`got existing: ${JSON.stringify(data)}`)
        params.Item = data.Item
        if ( !params.Item.units ) {
          params.Item.units = {}
        }
        params.Item.units[unitsTypeVal] = unitsVal
      }

      console.log(`params:  ${JSON.stringify(params)}`)

      docClient.put(params, (err, data) => {
        if ( err ) {
          console.log(`put error: ${err}`)
        }
        respond(this, `I will now use ${unitsVal} for ${unitsTypeVal}`)
      })
    })
  },
  'AMAZON.HelpIntent': function () {
    const speechOutput = this.t('HELP_MESSAGE');
    const reprompt = this.t('HELP_MESSAGE');
    this.emit(':ask', speechOutput, reprompt);
  },
  'AMAZON.CancelIntent': function () {
    this.emit(':tell', this.t('STOP_MESSAGE'));
  },
  'AMAZON.StopIntent': function () {
    this.emit(':tell', this.t('STOP_MESSAGE'));
  },
  'SessionEndedRequest': function () {
    this.response.speak(this.t('STOP_MESSAGE'));
    this.emit(':responseReady');
  }
};

exports.handler = function (event, context) {
  console.log('in handler')
  const alexa = Alexa.handler(event, context);
  alexa.APP_ID = APP_ID;
  // To enable string internationalization (i18n) features, set a resources object.
  alexa.resources = languageStrings;
  alexa.registerHandlers(handlers);
  alexa.execute();
};


function getValue(url, path, user, cb, conversion) {
  var url = url + path.replace(/\./g, '/')
  request(url,
          (error, response, body) => {
            console.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)} ${error}`)
            if ( error ) {
              cb(error, null)
            } else if ( response.statusCode != 200 ) {
              cb(new Error(`invalid response ${response.statusCode}`))
            } else {
              cb(null, conversion ? conversion(body, user) : body)
            }
          })
}


function getUserData(that, cb) {
  var mmsi
  var userId = that.event.session.user.userId
  
  mmsi = _.get(that.event.request.intent.slots, 'mmsi.value')

  if ( mmsi ) {
    getValue(getBaseURL(mmsi), "mmsi", null, (err, value) => {
      console.log('found mmsi')
      if ( err ) {
        elicit(that, 'mmsi', `I was unable to find the m m s i ${mmsi} in the Signal K Cloud. Please say your m m s i again.`)
        cb(null, null)
      } else {
        console.log('save mmsi')
        const params = {
          TableName: usersTable,
          Item: {
            userId: userId,
            mmsi: mmsi
          }
        };
        
        console.log(`mmsi ${JSON.stringify(params)}`)
        docClient.put(params, (err, data) => {
          if ( err ) {
            console.log(`put error: ${err}`)
          }
          cb(err, params.Item)
        })
      }
    })
  } else {
    const params = {
      TableName: usersTable,
      Key: {
        userId: userId,
      }
    };
    
    docClient.get(params, (err, data) => {
      if ( err ) {
        console.log(`get error: ${err}`)
      }
      if ( !data || !data.Item  ) {
        elicit(that, 'mmsi', 'What is your m m s i?')
        cb(null, null)
      } else {
        cb(err, data.Item)
      }
    })
  }
}

function respond(that, messsage) {
  console.log(`respoonding with ${messsage}`)
  that.attributes.speechOutput = messsage;
  that.response.speak(messsage);
  that.response.cardRenderer('Signal K', messsage);
  that.emit(':responseReady');
}

function elicit(that, slotToElicit, speechOutput) {
  const repromptSpeech = speechOutput;
  that.emit(':elicitSlot', slotToElicit, speechOutput, repromptSpeech);
}
