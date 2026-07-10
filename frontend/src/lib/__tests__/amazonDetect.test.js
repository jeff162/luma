import { describe, it, expect } from 'vitest'

import { sniffAmazonExportKind, isAmazonExportHeader } from '../amazonDetect.js'

const ORDERS_HEADER = 'order id,order url,items,to,date,total,shipping,shipping_refund,gift,tax,refund,payments'
const ITEMS_HEADER = 'order id,order url,order date,quantity,description,item url,price,subscribe & save,ASIN,category'

describe('sniffAmazonExportKind', () => {
  it('recognizes the orders export by its payments/total columns', () => {
    expect(sniffAmazonExportKind(ORDERS_HEADER)).toBe('orders')
  })

  it('recognizes the items export by its ASIN/description/price columns', () => {
    expect(sniffAmazonExportKind(ITEMS_HEADER)).toBe('items')
  })

  it('strips a UTF-8 BOM on the first header cell', () => {
    expect(sniffAmazonExportKind('\uFEFF' + ORDERS_HEADER)).toBe('orders')
  })

  it('is case-insensitive', () => {
    expect(sniffAmazonExportKind(ITEMS_HEADER.toUpperCase())).toBe('items')
  })

  it('returns null for an unrelated CSV header', () => {
    expect(sniffAmazonExportKind('date,amount,description,memo')).toBeNull()
    expect(sniffAmazonExportKind('')).toBeNull()
    expect(sniffAmazonExportKind(null)).toBeNull()
  })

  it('isAmazonExportHeader is the boolean form', () => {
    expect(isAmazonExportHeader(ORDERS_HEADER)).toBe(true)
    expect(isAmazonExportHeader('date,amount')).toBe(false)
  })
})
