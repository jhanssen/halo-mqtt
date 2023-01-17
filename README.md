# halo-mqtt
Node project for exposing Eaton HALO Home Smart Lights to [Home Assistant](https://www.home-assistant.io/) through [MQTT discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery).

Some of the code code was ported from [halohome](https://github.com/nayaverdier/halohome) and [csrmesh](https://github.com/nkaminski/csrmesh/blob/master/csrmesh/crypto.py).

## Requirements
You need to have provisioned the lights using the Halo Home app prior to using this project. This code talks directly to the lights over Bluetooth and depends on [BlueZ](http://www.bluez.org/) for this. It thus needs to be run on a Linux system with an available Bluetooth adapter.

## Configuration
`--halo-email`: Login e-mail for the Halo Home app (required).  
`--halo-password`: Login password for the Halo Home app (required).  
`--mqtt-host`: Host name for your MQTT server (required).  
`--mqtt-user`: Login user for the MQTT server (optional).  
`--mqtt-password`: Login password for the MQTT server (optional).  
`--bluez-interface`: What BlueZ interface to use (optional, defaults to `hci0`).  

## Building
Running the following commands

    npm install
    npm run build

Should result in a debug and release .js file in a folder named `dist`.

## Known issues
The Bluetooth connection to the lights sometimes times out. If this happens on launch when initializing the lights the only current solution is to quit and relaunch.
