const debug = require('debug')('y2m.device');

// При сохранении конфигурации HA сохраняет её в Latin1, кодируя все все русские символы в виде, например:
// Комната -> \u041a\u043e\u043c\u043d\u0430\u0442\u0430
// Делаем воркэраунд, декодируя UTF-8
function fixEncoding(str) {
  if (str) {
    str = `${str}`;
    if (str.includes('"')) //
    {
      return str;
    }
    return eval(`"${str}"`);
  }
}

function convertValue(valueMapping, val) {
  let mqttVal;
  if (valueMapping == "rgb") {
      var col_r=(val >> 16)&0xff;
      var col_g=(val >> 8)&0xff;
      var col_b= val &0xff;
      mqttVal={"r":col_r,"g":col_g,"b":col_b};
  } else {
    if (!valueMapping) valueMapping="default"
    if (global.valueMappings[valueMapping]) {
      debug('Using value mapping: %s', valueMapping);
      mqttVal = global.valueMappings[valueMapping][val];
      debug('Value mapped: %s -> %s', val, mqttVal);
      if ( typeof mqttVal === 'undefined' ) { 
        mqttVal = val;
        debug('Mapping undefined using value %s', val);
      }
    } else {
      if (valueMapping) {
        debug(`Config error: unknown value mapping: ${valueMapping}`);
      }
      mqttVal = `${val}`;
    }
  }
  return mqttVal;
}

function getDataByPath(data, path) {
     path.split(".").forEach(element => data=data[element]);
     return data;
  }

function convertToYandexValue(val, type, instance) {
  if (type.startsWith('devices.capabilities.')) {
    const capType = type.slice(21);
    switch (capType) {
      case 'toggle':
      case 'on_off': {
        if (val == null) return false;
        val = `${val}`;
        switch (val.toLowerCase()) {
          case 'true':
          case 'on':
          case '1':
            return true;
          default:
            return false;
        }
      }
      case 'range': {
        if (val == null) return 0.0;
        try {
          return parseFloat(val);
        } catch (err) {
          debug(`Cannot parse the range state value: ${val}`);
          return 0.0;
        }
      }
      case 'color_setting': {
        return val.r*256*256+val.g*256+val.b;
      }
      case 'mode': {
        return val;
      }
      default: {
        debug(`Unsupported capability type: ${type}`);
        return val;
      }
    }
  } else if (type.startsWith('devices.properties.')) {
    const propType = type.slice(19);
    switch (propType) {
      case 'float': {
        if (val == null) return 0.0;
        try {
          return parseFloat(val);
        } catch (err) {
          debug(`Cannot parse the float value: ${val}`);
          return 0.0;
        }
      }
      default: {
        debug(`Unsupported property type: ${type}`);
        return val;
      }
    }
  }
}

class device {
  constructor(options) {
    debug(`Creating device: ${options.id}`);
    const id = global.devices.length;
    this.data = {
      id: options.id || String(id),
      name: fixEncoding(options.name) || 'Без названия',
      description: fixEncoding(options.description) || '',
      room: fixEncoding(options.room) || '',
      type: options.type || 'devices.types.light',
      capabilities: options.capabilities,
      properties: options.properties,
      complexState: options.complexState || {},
    };
    this.data.capabilities.forEach((capability) => {
      debug(`Creating capability: ${capability.type}`);
      capability.state = this.initState(capability);
    });
    global.devices.push(this);
  }

  // Returns all capability definitions (to Yandex).
  getDefinition() {
    const definition = {};
    definition.id = this.data.id;
    definition.name = this.data.name;
    definition.description = this.data.description;
    definition.room = this.data.room;
    definition.type = this.data.type;
    definition.capabilities = [];
    this.data.capabilities.forEach((capability) => {
      const capDef = {};
      capDef.type = capability.type;
      capDef.retrievable = capability.retrievable;
      capDef.parameters = capability.parameters;
      definition.capabilities.push(capDef);
    });
    definition.properties = [];
    this.data.properties.forEach((property) => {
      const propDef = {};
      propDef.type = property.type;
      propDef.retrievable = property.retrievable;
      propDef.parameters = property.parameters;
      definition.properties.push(propDef);
    });
    return definition;
  }

  // Returns the current capability states (to Yandex).
  getState() {
    const state = {};
    state.id = this.data.id;
    state.capabilities = [];
    this.data.capabilities.forEach((capability) => {
      const capState = {};
      capState.type = capability.type;
      capState.state = Object.assign({}, capability.state);
      capState.state.instance=capability.parameters.instance;
      state.capabilities.push(capState);
    });
    if (this.data.properties) {
      state.properties = [];
      this.data.properties.forEach((property) => {
        const propState = {};
        propState.type = property.type;
        propState.state = property.state;
        state.properties.push(propState);
      });
    }
    return state;
  }

  initState(capability) {
    const state = capability.state || {}; // There can be mqtt publish/query topics configured
    const capType = capability.type.slice(21);
    state.instance = capability.parameters.instance;
    switch (capType) {
      case 'on_off': {
        if (!state.value) {
          state.value = false;
        }
        break;
      }
      case 'toggle': {
        state.value = false;
        break;
      }      
      case 'mode': {
        state.value = capability.parameters.modes[0].value;
        break;
      }
      case 'range': {
        state.value = capability.parameters.range.min;
        break;
      }
      case 'color_setting': {
        state.value = 7207110;
        break;
      }
      default: {
        debug(`Unsupported capability type: ${capability.type}`);
        break;
      }
    }
    return state;
  }

  findCapability(type) {
    return this.data.capabilities.find(capability => capability.type === type);
  }
  
  findProperty(type) {
    return this.data.properties.find(property => property.state.instance === type);
  }
  

  // Кешируем значение, переданное нам Яндексом, и пропихиваем его в MQTT
  setState(type, val, relative) {
    let mqttVal;
    let topic;
    let instance;
    try {
      const capability = this.findCapability(type);
      if (relative) {
        debug(`*** Relative: ${capability.state.value} += ${val}`);
        if (capability.state.value == null) {
          capability.state.value = 50;
        }
        capability.state.value += val;
      } else {
        debug(`*** Absolute: ${capability.state.value} -> ${val}`);
        capability.state.value = val;
      }
      topic = capability.state.publish || false;
      instance = capability.state.instance;
      mqttVal = convertValue(capability.mappingRef, `${val}`);
    } catch (err) {
      topic = false;
      console.log(err);
    }
    if (topic) {
      debug(`MQTT publish: '${mqttVal}' -> ${topic}`);
      this.client.publish(topic, mqttVal, { retain: true });
    }
    return {
      type,
      state: {
        instance,
        action_result: {
          status: 'DONE',
        },
      },
    };
  }

  // eslint-disable-next-line max-len
  // Collects all capability states and construct a complex state that should be sent via MQTT (if required)
  propagateComplexState() {
    const topic = this.data.complexState.publish || false;
    var val;
    if (topic) {
      const complexState = {};
      this.data.capabilities.forEach((capability) => {
        if (!capability.state.publish) {
          val = convertValue(capability.mappingRef, `${capability.state.value}`);
          complexState[capability.parameters.local] = val;
        }
      });
      const complexStateStr = JSON.stringify(complexState);
      debug(`MQTT publish: ${complexStateStr} -> ${topic}`);
      this.client.publish(topic, complexStateStr, { retain: true });
    }
  }

  updateStateC(type, val) {
    debug(`Updating cached state for device '${this.data.name}' (ID=${this.data.id})`);
    try {
      const capability = this.findCapability(type);
      val = convertToYandexValue(val, capability.type, capability.state.instance);
      capability.state.value = val;
      debug(`.. updated cached state for device '${this.data.name}' (ID=${this.data.id}): ${val}`);
    } catch (err) {
      console.log(err);
      console.log(`Cannot update capability state for device='${this.data.name
      }' (ID=${this.data.id}), capability type='${type}'`);
    }
  }

  updateStateP(type, val) {
    debug(`Updating cached state for device '${this.data.name}' (ID=${this.data.id})`);
    try {
      debug(`-P Parsing: ${val}`);
      var StateP = JSON.parse(val);  
      const property = this.findProperty(type);
      if (property) {
        val = getDataByPath(StateP, property.parameters.local.toString().toLowerCase());
        var instance = property.parameters.instance
        property.state.instance = instance;
        val = convertToYandexValue(val, property.type, instance);
        property.state.value = val;
        debug(`.. updated cached state for device '${this.data.name}' (ID=${this.data.id}): ${val}`);
      }
    } catch (err) {
      console.log(err);
      console.log(`Cannot update capability state for device='${this.data.name
      }' (ID=${this.data.id}), capability type='${type}'`);
    }
  }

  updateComplexState(complexStateStr) {
    try {
      debug(`-- Parsing: ${complexStateStr}`);
      const complexState = JSON.parse(complexStateStr);
      this.data.capabilities.forEach((capability) => {
        if (!capability.state.query) {
          var search=capability.parameters.local||capability.state.instance;
          const val = getDataByPath(complexState, search.toString().toLowerCase());
          if (val !== undefined) {
            debug(`-- capability[${capability.state.instance}]=${val}`);
            capability.state.value = convertToYandexValue(
              val,
              capability.type,
              capability.state.instance,
            );
          }
        }
      });
      if (this.data.properties) {
        this.data.properties.forEach((property) => {
          var instance = property.parameters.instance
          const val = getDataByPath(complexState, property.parameters.local.toString().toLowerCase());
          if (val !== undefined) {
            debug(`-- property[${instance}]=${val}`);
            property.state = {};
            property.state.instance = instance;
            property.state.value = convertToYandexValue(
              val,
              property.type,
              property.state.instance,
            );
          }
        });
      }
    } catch (err) {
      debug(`Cannot parse the complex state string "${complexStateStr}": ${err}`);
    }
  }
}

module.exports = device;
