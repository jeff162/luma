import { describe, expect, it } from 'vitest'

import { distributeRemainder } from '../splitDistribution.js'

const sum = values => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100

describe('distributeRemainder', () => {
  it('spreads the remainder in proportion to what each part holds', () => {
    // Tax and shipping of 15 on items of 60 and 40.
    expect(distributeRemainder([60, 40], 15)).toEqual([69, 46])
  })

  it('lands on the total exactly when the shares do not divide into cents', () => {
    const result = distributeRemainder([10, 10, 10], 1)
    expect(sum(result)).toBe(31)
    expect(result).toEqual([10.34, 10.33, 10.33])
  })

  it('gives the leftover cent to the part rounding shorted most, not the first', () => {
    // Exact shares of 100.14 / 200.29 / 400.57 cents: the floors leave one cent, which belongs to the
    // last part (fraction .57) rather than either earlier one.
    const result = distributeRemainder([1, 2, 4], 0.01)
    expect(sum(result)).toBe(7.01)
    expect(result).toEqual([1, 2, 4.01])
  })

  it('scales the parts down when they are over the total', () => {
    const result = distributeRemainder([30, 30, 30], -10)
    expect(sum(result)).toBe(80)
    expect(result).toEqual([26.67, 26.67, 26.66])
  })

  it('leaves a part holding nothing at zero', () => {
    expect(distributeRemainder([50, 0, 25], 15)).toEqual([60, 0, 30])
  })

  it('declines when there is nothing to weigh by', () => {
    expect(distributeRemainder([0, 0], 100)).toBeNull()
  })
})
