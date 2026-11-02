'use strict';

const { spawn } = require('child_process');
const { createSocket } = require('dgram');
const { EventEmitter } = require('events');
const { Buffer } = require('node:buffer');
const { existsSync } = require('node:fs');
const { Writable } = require('stream');
const find = require('find-process');
const kill = require('tree-kill');
// `werift-rtp` ton ~19MB va ~25ms luc nap, va chi can khi that su co goi RTP di qua.
// Nap o lan dung dau tien de nguoi chi dung REST khong phai tra tien cho no.
let RtpPacket = null;
function rtpPacket() {
  RtpPacket ??= require('werift-rtp').RtpPacket;
  return RtpPacket;
}
const { randomPorts } = require('../util/Function');
const { getSDPCodecName } = require('../util/Sdp');
const { StreamOutput } = require('../util/Socket');
const { getPayloadType } = require('../util/VoiceConstants');

/**
 * Chọn đúng tiến trình ffmpeg do Recorder này sinh ra.
 *
 * Chỉ khớp theo pid hoặc ppid. Bản v13 còn khớp cả tiến trình nào có dòng lệnh
 * chứa cùng bộ tham số, mà hai Recorder chạy song song (hay ffmpeg của chương
 * trình khác) có thể trùng tham số — thế là kill nhầm tiến trình không phải của mình.
 * @param {Array<{pid: number, ppid: number}>} list Kết quả của `find-process`
 * @param {number} ffmpegPid Pid của tiến trình đã spawn
 * @returns {?Object}
 */
function findOwnFFmpeg(list, ffmpegPid) {
  if (!ffmpegPid) return null;
  return list.find(o => o.pid === ffmpegPid || o.ppid === ffmpegPid) ?? null;
}

/**
 * Cờ ghi đè truyền cho ffmpeg.
 *
 * Output là stream thì ffmpeg ghi vào socket mà chính Recorder vừa mở. Trên Windows
 * đó là named pipe `\\.\pipe\...`, ffmpeg coi như file thường và thấy nó đã tồn
 * tại, nên `-n` sẽ làm ffmpeg thoát ngay. Chỉ đường dẫn file mới cần chặn ghi đè.
 * @param {boolean} isStream Output có phải stream không
 * @param {boolean} overwrite Người dùng cho phép ghi đè
 * @returns {string}
 */
function overwriteFlag(isStream, overwrite) {
  return isStream || overwrite ? '-y' : '-n';
}

/**
 * Represents a FFmpeg handler
 * @extends {EventEmitter}
 */
class Recorder extends EventEmitter {
  constructor(receiver, { userId, portUdpH264, portUdpOpus, output, overwrite = false } = {}) {
    super();

    // Bản cũ luôn chạy ffmpeg với `-y`: đường dẫn lỡ trỏ vào file có sẵn là mất file
    // đó, không hỏi. Ném ở đây, đồng bộ, để người gọi biết ngay chứ không phải đợi
    // ffmpeg thoát.
    if (typeof output === 'string' && !overwrite && existsSync(output)) {
      throw new Error(`Recorder output already exists, pass { overwrite: true } to replace it: ${output}`);
    }

    /**
     * Có ghi đè file output đã tồn tại hay không
     * @type {boolean}
     */
    this.overwrite = overwrite;

    Object.defineProperty(this, 'receiver', { value: receiver });

    /**
     * The user ID
     * @type {Snowflake}
     */
    this.userId = userId;

    this.portUdpH264 = portUdpH264;
    this.portUdpH265 = null;
    this.portUdpOpus = portUdpOpus;

    this.promise = null;

    if (!portUdpH264 || !portUdpOpus) {
      this.promise = randomPorts(6, 'udp4').then(ports => {
        ports = ports.filter(port => port % 2 === 0);
        this.portUdpH264 ??= ports[0];
        this.portUdpOpus ??= ports[1];
      });
    }

    /**
     * The output of the stream
     * @type {string|Readable}
     */
    this.output = output;

    /**
     * The FFmpeg process is ready or not
     * @type {boolean}
     */
    this.ready = false;

    this.socket = createSocket('udp4');

    this.init(output);
  }
  async init(output) {
    await this.promise;
    const sdpData = getSDPCodecName(this.portUdpH264, this.portUdpH265, this.portUdpOpus);
    const isStream = output instanceof Writable;
    if (isStream) {
      this.outputStream = StreamOutput(output);
    }
    const stream = spawn('ffmpeg', [
      '-reorder_queue_size',
      '500',
      '-thread_queue_size',
      '500',
      '-err_detect',
      'ignore_err',
      '-flags2',
      '+export_mvs',
      '-fflags',
      '+genpts+discardcorrupt',
      '-use_wallclock_as_timestamps',
      '1',
      '-f',
      'sdp',
      '-analyzeduration',
      '1M',
      '-probesize',
      '1M',
      '-protocol_whitelist',
      'file,udp,rtp,pipe,fd',
      '-i',
      '-', // Read from stdin
      '-buffer_size',
      '4M',
      '-max_delay',
      '500000', // 500ms
      '-rtbufsize',
      '4M',
      '-c',
      'copy',
      overwriteFlag(isStream, this.overwrite),
      '-f',
      'matroska',
      isStream ? this.outputStream.url : output,
    ]);

    /**
     * The FFmpeg process
     * @type {ChildProcessWithoutNullStreams}
     */
    this.stream = stream;
    this.stream.stdin.write(sdpData);
    this.stream.stdin.end();
    this.stream.stderr.once('data', data => {
      this.emit('debug', `stderr: ${data}`);
      this.ready = true;
      this.emit('ready');
    });
  }
  /**
   * Send a payload to FFmpeg via UDP
   * @param {RtpPacket|string|Buffer} payload The payload
   * @param {*} callback Callback
   */
  feed(
    payload,
    callback = e => {
      if (e) {
        console.error('Error sending packet:', e);
      }
    },
  ) {
    if (!(payload instanceof rtpPacket())) {
      payload = rtpPacket().deSerialize(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    }
    const message = payload.serialize();
    // Get port from payloadType
    let port;
    if (payload.header.payloadType === getPayloadType('opus')) {
      port = this.portUdpOpus;
    } else if (payload.header.payloadType === getPayloadType('H264')) {
      port = this.portUdpH264;
    } else if (payload.header.payloadType === getPayloadType('H265')) {
      port = this.portUdpH265;
    } else {
      return;
    }
    this.socket.send(message, 0, message.length, port, '127.0.0.1', callback);
  }

  destroy() {
    find('name', 'ffmpeg', true).then(list => {
      const process = findOwnFFmpeg(list, this.stream.pid);
      if (process) {
        kill(process.pid);
        this.receiver?.videoStreams?.delete(this.userId);
        this.emit('closed');
      }
    });
  }

  /**
   * Emitted when the Recorder becomes ready to start working.
   * @event Recorder#ready
   */

  /**
   * Emitted when the Recorder is closed.
   * @event Recorder#closed
   */
}

module.exports = Recorder;
module.exports.findOwnFFmpeg = findOwnFFmpeg;
module.exports.overwriteFlag = overwriteFlag;
