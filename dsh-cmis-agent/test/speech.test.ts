import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { generateSignature, mapAudioFormat } from '../src/gateway/speech.ts'
import type { ClientSpeechControl } from '../src/gateway/types.ts'

// ---- 签名与格式映射（自 cmis-report-agent xf-realtime.ts 迁移，算法不变） ----

test('generateSignature：参数按 key 升序 HMAC-SHA1 签名（与旧实现一致）', () => {
    const params = { appId: 'app-1', accessKeyId: 'key-1', utc: '2026-08-27T10:00:00+08:00', uuid: 'u-1' }
    const signature = generateSignature(params, 'secret-1')
    // 手工构造相同查询串，用 node:crypto 独立计算期望值
    const queryString = 'accessKeyId=key-1&appId=app-1&utc=2026-08-27T10%3A00%3A00%2B08%3A00&uuid=u-1'
    const expected = createHmac('sha1', 'secret-1').update(queryString).digest('base64')
    assert.equal(signature, expected)
})

test('mapAudioFormat：录音格式映射讯飞音频编码', () => {
    assert.equal(mapAudioFormat('PCM'), 'pcm_s16le')
    assert.equal(mapAudioFormat('wav'), 'pcm_s16le')
    assert.equal(mapAudioFormat('opus'), 'opus-wb')
    assert.equal(mapAudioFormat('speex'), 'speex-7')
    assert.equal(mapAudioFormat(undefined), 'pcm_s16le')
})

// ---- 语音控制协议结构 ----

test('ClientSpeechControl：协议结构（start 携带录音参数，end/cancel 轻量）', () => {
    const start: ClientSpeechControl = {
        type: 'speech',
        requestId: 1001,
        stream: 'start',
        speechProperties: { sampleRate: 8000, format: 'PCM' },
        deptCode: 'D01',
    }
    assert.equal(start.type, 'speech')
    assert.equal(start.speechProperties?.sampleRate, 8000)
    assert.equal(start.deptCode, 'D01')

    const end: ClientSpeechControl = { type: 'speech', requestId: 1001, stream: 'end' }
    assert.equal(end.stream, 'end')
    assert.equal(end.speechProperties, undefined)

    const cancel: ClientSpeechControl = { type: 'speech', requestId: 1001, stream: 'cancel' }
    assert.equal(cancel.stream, 'cancel')
})
