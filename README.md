# Homebridge Camera FFmpeg PTZ

[![npm](https://badgen.net/npm/v/homebridge-camera-ffmpeg-ptz) ![npm](https://badgen.net/npm/dt/homebridge-camera-ffmpeg-ptz)](https://www.npmjs.com/package/homebridge-camera-ffmpeg-ptz) [![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins) [![certified-hoobs-plugin](https://badgen.net/badge/HOOBS/certified/yellow)](https://plugins.hoobs.org/plugin/homebridge-camera-ffmpeg)

[Homebridge](https://homebridge.io) Plugin Providing [FFmpeg](https://www.ffmpeg.org)-based Camera Support

## Installation

This plugin is supported under both [Homebridge](https://homebridge.io) and [HOOBS](https://hoobs.org/). It is highly recommended that you use either [Homebridge Config UI X](https://www.npmjs.com/package/homebridge-config-ui-x) or the HOOBS UI to install and configure this plugin.

### Manual Installation

1. Install this plugin using: `sudo npm install -g homebridge-camera-ffmpeg-ptz --unsafe-perm`.
2. Edit `config.json` manually to add your cameras. See below for instructions on that.

## Tested configurations

Other users have been sharing configurations that work for them on our GitHub site. You may want to [check that](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/configs/) to see if anyone else has gotten your model of camera working already, or [share](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg/issues/new?assignees=&labels=tested+config&template=tested_config.md) a configuration setup that works for you.

## Manual Configuration

### Most Important Parameters

- `platform`: _(Required)_ Must always be set to `Camera-ffmpeg`.
- `name`: _(Required)_ Set the camera name for display in the Home app.
- `source`: _(Required)_ FFmpeg options on where to find and how to decode your camera's video stream. The most basic form is `-i` followed by your camera's URL.
- `stillImageSource`: If your camera also provides a URL for a still image, that can be defined here with the same syntax as `source`. If not set, the plugin will grab one frame from `source`.

#### Config Example

```json
{
  "platform": "Camera-ffmpeg",
  "cameras": [
    {
      "name": "Camera Name",
      "videoConfig": {
        "source": "-i rtsp://username:password@example.com:554",
        "stillImageSource": "-i http://example.com/still_image.jpg",
        "maxStreams": 2,
        "maxWidth": 1280,
        "maxHeight": 720,
        "maxFPS": 30
      }
    }
  ]
}
```

### Optional Parameters

- `motion`: Exposes the motion sensor for this camera. This can be triggered with [dummy switches](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/switch.html), [MQTT messages](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/mqtt.html), or [via HTTP](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/http.html), depending on what features are enabled in the config. (Default: `false`)
- `doorbell`: Exposes the doorbell device for this camera. This can be triggered with [dummy switches](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/switch.html), [MQTT messages](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/mqtt.html), or [via HTTP](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/http.html), depending on what features are enabled in the config. (Default: `false`)
- `switches`: Enables dummy switches to trigger motion and/or doorbell, if either of those are enabled. When enabled there will be an additional switch that triggers the motion or doorbell event. See the project site for [more detailed instructions](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/switch.html). (Default: `false`)
- `motionTimeout`: The number of seconds after triggering to reset the motion sensor. Set to 0 to disable resetting of motion trigger for MQTT or HTTP. (Default: `1`)
- `motionDoorbell`: Rings the doorbell when motion is activated. This allows for motion alerts to appear on Apple TVs. (Default: `false`)
- `onvifEvents`: Optional ONVIF PullPoint event listener. Requires `motion: true`, ONVIF host/credentials, and at least one topic filter. Configure `motionTopic` and, when supported by the camera, `personTopic` as case-sensitive substrings of ONVIF event topic names. The listener prints each topic once in Homebridge debug logs (`-D`) to help identify topic filters. Matching person events trigger the same generic HomeKit motion sensor; HomeKit does not receive a person classification from this plugin. ONVIF event names and person analytics support vary by camera firmware.
- `ptz`: Enables ONVIF pan-tilt controls for a camera. When enabled, HomeKit exposes Up, Down, Left, Right, and Stop switches on the camera accessory. HomeKit shows these as separate switches, not as directional controls inside the camera's live view. Each directional command stops automatically after `duration` milliseconds. Optional `presets` define additional switches that recall named camera positions using their ONVIF tokens. The `host` is required when enabled; `port` defaults to `80`, `speed` to `0.35`, and `duration` to `500` milliseconds. Speed must be greater than `0` and at most `1`; duration must be from `1` to `60000` milliseconds. PTZ requires a camera that supports ONVIF PTZ. ONVIF credentials are stored in the Homebridge configuration, typically in plaintext.
- `manufacturer`: Set the manufacturer name for display in the Home app. (Default: `Homebridge`)
- `model`: Set the model for display in the Home app. (Default: `Camera FFmpeg`)
- `serialNumber`: Set the serial number for display in the Home app. (Default: `SerialNumber`)
- `firmwareRevision`: Set the firmware revision for display in the Home app. (Default: current plugin version)
- `unbridge`: Bridged cameras can cause slowdowns of the entire Homebridge instance. If unbridged, the camera will need to be added to HomeKit manually. (Default: `true`)

#### Config Example with Manufacturer and Model Set

```json
{
  "platform": "Camera-ffmpeg",
  "cameras": [
    {
      "name": "Camera Name",
      "manufacturer": "ACME, Inc.",
      "model": "ABC-123",
      "serialNumber": "1234567890",
      "firmwareRevision": "1.0",
      "videoConfig": {
        "source": "-i rtsp://username:password@example.com:554",
        "stillImageSource": "-i http://example.com/still_image.jpg",
        "maxStreams": 2,
        "maxWidth": 1280,
        "maxHeight": 720,
        "maxFPS": 30
      }
    }
  ]
}
```

#### PTZ Configuration

```json
{
  "ptz": {
    "enabled": true,
    "host": "192.168.1.17",
    "port": 80,
    "username": "admin",
    "password": "your-camera-password",
    "speed": 0.35,
    "duration": 500,
    "presets": [
      {
        "name": "Entrée",
        "token": "camera-preset-token"
      },
      {
        "name": "Salon",
        "token": "another-camera-preset-token"
      }
    ]
  }
}
```

The `token` values must match the ONVIF preset tokens assigned by the camera; preset names such as `Home`, `Position 1`, or `Cruise` are not reliably equivalent to the ONVIF token. Each configured preset appears as a separate HomeKit switch. For a camera without PTZ, omit the `ptz` section or set `"enabled": false`.

#### ONVIF Motion and Person Events

```json
{
  "motion": true,
  "onvifEvents": {
    "enabled": true,
    "host": "192.168.1.17",
    "port": 80,
    "username": "admin",
    "password": "your-camera-password",
    "motionTopic": "CellMotionDetector/Motion",
    "personTopic": "PeopleDetection"
  }
}
```

Enable Homebridge debug logging with `-D` and check the logs for `ONVIF event topic:` entries. Copy a stable, camera-reported topic substring into `motionTopic` or `personTopic`. Leave `personTopic` unset if the camera does not publish a person-detection event. A matching person event activates the same HomeKit motion sensor as a motion event; HomeKit does not represent person classification through this accessory service.

### Optional videoConfig Parameters

- `returnAudioTarget`: _(EXPERIMENTAL - WIP)_ The FFmpeg output command for directing audio back to a two-way capable camera. This feature is still in development and a configuration that works today may not work in the future.
- `maxStreams`: The maximum number of streams that will be allowed at once to this camera. (Default: `2`)
- `maxWidth`: The maximum width used for video streamed to HomeKit. If set to 0, the resolution of the source is used. If not set, will use any size HomeKit requests.
- `maxHeight`: The maximum height used for video streamed to HomeKit. If set to 0, the resolution of the source is used. If not set, will use any size HomeKit requests.
- `maxFPS`: The maximum frame rate used for video streamed to HomeKit. If set to 0, the framerate of the source is used. If not set, will use any frame rate HomeKit requests.
- `maxBitrate`: The maximum bitrate used for video streamed to HomeKit, in kbit/s. If not set, will use any bitrate HomeKit requests.
- `forceMax`: If set, the settings requested by HomeKit will be overridden with any 'maximum' values defined in this config. (Default: `false`)
- `vcodec`: Set the codec used for encoding video sent to HomeKit, must be H.264-based. You can change to a hardware accelerated video codec with this option, if one is available. (Default: `libx264`)
- `audio`: Enables audio streaming from camera. (Default: `false`)
- `packetSize`: If audio or video is choppy try a smaller value, should be set to a multiple of 188. (Default: `1316`)
- `mapvideo`: Selects the stream used for video. (Default: FFmpeg [automatically selects](https://ffmpeg.org/ffmpeg.html#Automatic-stream-selection) a video stream)
- `mapaudio`: Selects the stream used for audio. (Default: FFmpeg [automatically selects](https://ffmpeg.org/ffmpeg.html#Automatic-stream-selection) an audio stream)
- `videoFilter`: Comma-delimited list of additional video filters for FFmpeg to run on the video. If 'none' is included, the default video filters are disabled.
- `encoderOptions`: Options to be passed to the video encoder. (Default: `-preset ultrafast -tune zerolatency` if using libx264)
- `debug`: Includes debugging output from the main FFmpeg process in the Homebridge log. (Default: `false`)
- `debugReturn`: Includes debugging output from the FFmpeg used for return audio in the Homebridge log. (Default: `false`)

#### More Complicated Example

```json
{
  "platform": "Camera-ffmpeg",
  "cameras": [
    {
      "name": "Camera Name",
      "videoConfig": {
        "source": "-i rtsp://myfancy_rtsp_stream",
        "stillImageSource": "-i http://faster_still_image_grab_url/this_is_optional.jpg",
        "maxStreams": 2,
        "maxWidth": 1280,
        "maxHeight": 720,
        "maxFPS": 30,
        "maxBitrate": 200,
        "vcodec": "h264_omx",
        "audio": false,
        "packetSize": 188,
        "hflip": true,
        "additionalCommandline": "-x264-params intra-refresh=1:bframes=0",
        "debug": true
      }
    }
  ]
}
```

### Camera MQTT Parameters

- `motionTopic`: The MQTT topic to watch for motion alerts.
- `motionMessage`: The message to watch for to trigger motion alerts. Will use the name of the camera if blank.
- `motionResetTopic`: The MQTT topic to watch for motion resets.
- `motionResetMessage`: The message to watch for to trigger motion resets. Will use the name of the camera if blank.
- `doorbellTopic`: The MQTT topic to watch for doorbell alerts.
- `doorbellMessage`: The message to watch for to trigger doorbell alerts. Will use the name of the camera if blank.

#### Camera MQTT Example

```json
{
  "platform": "Camera-ffmpeg",
  "cameras": [
    {
      "name": "Camera Name",
      "videoConfig": {
        "source": "-i rtsp://myfancy_rtsp_stream"
      },
      "mqtt": {
        "motionTopic": "home/camera",
        "motionMessage": "ON",
        "motionResetTopic": "home/camera",
        "motionResetMessage": "OFF",
        "doorbellTopic": "home/doobell",
        "doorbellMessage": "ON"
      }
    }
  ]
}
```

### Automation Parameters

- `mqtt`: Defines the hostname or IP of the MQTT broker to connect to for MQTT-based automation. If not set, MQTT support is not started. See the project site for [more information on using MQTT](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/mqtt.html).
- `portmqtt`: The port of the MQTT broker. (Default: `1883`)
- `tlsmqtt`: Use TLS to connect to the MQTT broker. (Default: `false`)
- `usermqtt`: The username used to connect to your MQTT broker. If not set, no authentication is used.
- `passmqtt`: The password used to connect to your MQTT broker. If not set, no authentication is used.
- `porthttp`: The port to listen on for HTTP-based automation. If not set, HTTP support is not started. See the project site for [more information on using HTTP](https://homebridge-plugins.github.io/homebridge-camera-ffmpeg/automation/http.html).
- `localhttp`: Only allow HTTP calls from localhost. Useful if using helper plugins that translate to HTTP. (Default: `false`)

#### Automation Example

```json
{
  "platform": "Camera-ffmpeg",
  "mqtt": "127.0.0.1",
  "porthttp": "8080",
  "cameras": []
}
```

### Rarely Needed Parameters

- `videoProcessor`: Defines which video processor is used to decode and encode videos, must take the same parameters as FFmpeg. Common uses would be `avconv` or the path to a custom-compiled version of FFmpeg. If not set, will use the included version of FFmpeg, or the version of FFmpeg installed on the system if no included version is available.

#### Rare Option Example

```json
{
  "platform": "Camera-ffmpeg",
  "videoProcessor": "/usr/bin/ffmpeg",
  "cameras": []
}
```

## Credit

Homebridge Camera FFmpeg is based on code originally written by [Khaos Tian](https://twitter.com/khaost).
