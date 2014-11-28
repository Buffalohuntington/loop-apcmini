var LoopGrid = require('loop-grid')
var Selector = require('loop-grid-selector')
var Holder = require('loop-grid-holder')
var Mover = require('loop-grid-mover')
var Repeater = require('loop-grid-repeater')
var Suppressor = require('loop-grid-suppressor')

var ObservMidi = require('observ-midi')
var ObservGridStack = require('observ-grid-stack')
var ObservGridGrabber = require('observ-grid/grabber')
var ObservMidiPort = require('midi-port-holder')
var MidiButtons = require('observ-midi/light-stack')
var watchButtons = require('./lib/watch-buttons.js')

var Observ = require('observ')
var ArrayGrid = require('array-grid')

var DittyGridStream = require('ditty-grid-stream')

var computedPortNames = require('midi-port-holder/computed-port-names')
var NormalizeMidiNotes = require('midi-port-holder/normalize-notes')

var watch = require('observ/watch')
var mapWatchDiff = require('./lib/map-watch-diff-stack.js')
var mapGridValue = require('observ-grid/map-values')
var computeIndexesWhereContains = require('observ-grid/indexes-where-contains')

var stateLights = require('./state-lights.js')
var repeatStates = [2, 1, 2/3, 1/2, 1/3, 1/4, 1/6, 1/8]


module.exports = function(opts){

  // resolve options
  var opts = Object.create(opts)
  var triggerOutput = opts.triggerOutput
  var scheduler = opts.scheduler
  var gridMapping = getApcMiniGridMapping()
  opts.shape = gridMapping.shape

  // controller midi port
  var portHolder = ObservMidiPort()
  var duplexPort = NormalizeMidiNotes(portHolder.stream)
  duplexPort.on('switch', turnOffAllLights)
  // duplexPort.on('data', function(notes){console.log(notes);})
  // window.port = duplexPort

  // extend loop-grid instance
  var self = LoopGrid(opts, {
    port: portHolder
  })

  // grab the midi for the current port
  self.grabInput = function(){
    portHolder.grab()
  }

  self.portChoices = computedPortNames()
  self.repeatLength = Observ(2)

  // loop transforms
  var transforms = {
    selector: Selector(gridMapping.shape, gridMapping.stride),
    holder: Holder(self.transform),
    mover: Mover(self.transform),
    repeater: Repeater(self.transform),
    suppressor: Suppressor(self.transform, gridMapping.shape, gridMapping.stride)
  }

  var outputLayers = ObservGridStack([

    // recording
    // mapGridValue(self.recording, stateLights.green),

    // active
    mapGridValue(self.active, stateLights.amber),

    // selected
    mapGridValue(transforms.selector, stateLights.greenFlash),

    // suppressing
    mapGridValue(transforms.suppressor, stateLights.red),

    // playing
    mapGridValue(self.playing, stateLights.green)

  ])

  var controllerGrid = ObservMidi(duplexPort, gridMapping, outputLayers)
  var inputGrabber = ObservGridGrabber(controllerGrid)

  var noRepeat = computeIndexesWhereContains(self.flags, 'noRepeat')
  var grabInputExcludeNoRepeat = inputGrabber.bind(this, {exclude: noRepeat})

  // trigger notes at bottom of input stack
  var output = DittyGridStream(inputGrabber, self.grid, scheduler)
  output.pipe(triggerOutput)

  // midi button mapping
  var buttons = MidiButtons(duplexPort, {
    store: '144/64',
    suppress: '144/65',
    undo: '144/66',
    redo: '144/67',
    hold: '144/68',
    snap1: '144/69',
    snap2: '144/70',
    select: '144/71'
  })

  watchButtons(buttons, {

    store: function(value){
      if (value){
        this.flash(stateLights.green)
        if (!self.transforms.getLength()){
          self.store()
        } else {
          self.flatten()
          transforms.selector.stop()
        }
      }
    },

    suppress: function(value){
      if (value){
        var turnOffLight = this.light(stateLights.red)
        transforms.suppressor.start(transforms.selector.selectedIndexes(), turnOffLight)
      } else {
        transforms.suppressor.stop()
      }
    },

    undo: function(value){
      if (value){
        self.undo()
        this.flash(stateLights.red, 100)
        buttons.store.flash(stateLights.red)
      }
    },

    redo: function(value){
      if (value){
        self.redo()
        this.flash(stateLights.red, 100)
        buttons.store.flash(stateLights.red)
      }
    },

    hold: function(value){
      if (value){
        var turnOffLight = this.light(stateLights.amber)
        transforms.holder.start(
          scheduler.getCurrentPosition(),
          transforms.selector.selectedIndexes(),
          turnOffLight
        )
      } else {
        transforms.holder.stop()
      }
    },

    select: function(value){
      if (value){
        var turnOffLight = this.light(stateLights.green)
        transforms.selector.start(inputGrabber, function done(){
          transforms.mover.stop()
          transforms.selector.clear()
          turnOffLight()
        })
      } else {
        if (transforms.selector.selectedIndexes().length){
          transforms.mover.start(inputGrabber, transforms.selector.selectedIndexes())
        } else {
          transforms.selector.stop()
        }
      }
    }
  })

  // light up undo buttons by default
  buttons.undo.light(stateLights.red)
  buttons.redo.light(stateLights.red)

  // light up store button when transforming (flatten mode)
  var releaseFlattenLight = null
  watch(self.transforms, function(values){
    if (values.length && !releaseFlattenLight){
      releaseFlattenLight = buttons.store.light(stateLights.green)
    } else if (releaseFlattenLight){
      releaseFlattenLight()
      releaseFlattenLight = null
    }
  })


  var repeatButtons = MidiButtons(duplexPort, {
    0: '144/82',
    1: '144/83',
    2: '144/84',
    3: '144/85',
    4: '144/86',
    5: '144/87',
    6: '144/88',
    7: '144/89'
  })

  // repeater
  var releaseRepeatLight = null
  mapWatchDiff(repeatStates, repeatButtons, self.repeatLength.set)
  watch(self.repeatLength, function(value){
    var button = repeatButtons[repeatStates.indexOf(value)]
    if (button){
      if (releaseRepeatLight) releaseRepeatLight()
      releaseRepeatLight = button.light(stateLights.amber)
    }
    transforms.holder.setLength(value)
    if (value < 2){
      transforms.repeater.start(grabInputExcludeNoRepeat, value)
    } else {
      transforms.repeater.stop()
    }
  })


  // visual metronome / loop position
  var currentBeat = null
  watch(self.loopPosition, function(value){
    var index = Math.floor(value / self.loopLength() * 8)
    if (index != currentBeat){
      var button = repeatButtons[index]
      if (button){
        button.flash(stateLights.green)
      }
      currentBeat = index
    }
  })

  // cleanup / disconnect from midi on destroy
  self._releases.push(
    turnOffAllLights,
    portHolder.destroy,
    output.destroy
  )

  return self




  // scoped

  function turnOffAllLights(){
    duplexPort.write([176, 0, 0])
  }

}



function getApcMiniGridMapping(){
  var result = []
  for (var r=0;r<8;r++){
    for (var c=0;c<8;c++){
      var noteId = 56 - (r << 3) | c
      result.push('144/' + noteId)
    }
  }
  return ArrayGrid(result, [8, 8])
}
