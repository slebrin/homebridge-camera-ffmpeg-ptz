import { describe, expect, it } from 'vitest'

import { parseOnvifEvent } from './onvifEvents.js'

describe('parseOnvifEvent', () => {
  it('extracts the topic and active state from ONVIF SimpleItem event data', () => {
    expect(parseOnvifEvent({
      topic: { _: 'tns1:RuleEngine/CellMotionDetector/Motion' },
      message: {
        message: {
          data: {
            simpleItem: {
              $: {
                Name: 'IsMotion',
                Value: true,
              },
            },
          },
        },
      },
    })).toEqual({
      topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
      active: true,
    })
  })

  it('recognizes false event values and events with repeated SimpleItems', () => {
    expect(parseOnvifEvent({
      topic: { _: 'RuleEngine/Motion' },
      message: {
        data: {
          simpleItem: [
            { $: { Name: 'IsMotion', Value: false } },
            { $: { Name: 'State', Value: false } },
          ],
        },
      },
    })).toEqual({ topic: 'RuleEngine/Motion', active: false })
  })

  it('leaves state unspecified when event data has no boolean SimpleItems', () => {
    expect(parseOnvifEvent({ topic: { _: 'RuleEngine/Motion' } }))
      .toEqual({ topic: 'RuleEngine/Motion' })
    expect(parseOnvifEvent({ message: {} })).toBeUndefined()
  })
})
