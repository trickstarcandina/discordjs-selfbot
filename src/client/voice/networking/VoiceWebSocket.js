'use strict';

const EventEmitter = require('events');
const { setTimeout, setInterval } = require('node:timers');
const { DAVE_PROTOCOL_VERSION } = require('./DAVESession');
const { stringifyRedacted } = require('../util/Redact');
const { VoiceOpcodes } = require('../util/VoiceConstants');
const WebSocket = require('../util/VoiceWebSocketShim');

/**
 * Mã đóng mà thử lại bao nhiêu lần cũng vậy. Bản port cứ thấy đóng là reconnect,
 * nên một lỗi vĩnh viễn biến thành năm vòng gõ cửa vô ích rồi caller ngồi chờ
 * tới `VOICE_CONNECTION_TIMEOUT` mà không biết lý do thật.
 * @type {Map<number, string>}
 */
const FATAL_CLOSE_CODES = new Map([
  [4004, 'Authentication failed'],
  [4006, 'Session is no longer valid'],
  [4017, 'E2EE/DAVE protocol required'],
]);

/**
 * Bị ngắt khỏi kênh — chuyện bình thường (bị kick, kênh bị xoá). Ngừng thử lại,
 * nhưng không nâng thành `error`: nhiều app không lắng nghe và sẽ chết theo.
 * @type {number}
 */
const DISCONNECTED_CLOSE_CODE = 4014;

/**
 * Represents a Voice Connection's WebSocket.
 * @extends {EventEmitter}
 * @private
 */
class VoiceWebSocket extends EventEmitter {
  constructor(connection) {
    super();
    /**
     * The Voice Connection that this WebSocket serves
     * @type {VoiceConnection}
     */
    this.connection = connection;

    /**
     * How many connection attempts have been made
     * @type {number}
     */
    this.attempts = 0;

    this._sequenceNumber = -1;

    /**
     * Ai đang trong kênh. DAVE cần danh sách này để kiểm người mới khi xử lý proposals.
     * @type {Set<Snowflake>}
     */
    this.connectedClients = new Set();

    this.dead = false;
    this.connection.on('closing', this.shutdown.bind(this));
  }

  /**
   * The client of this voice WebSocket
   * @type {Client}
   * @readonly
   */
  get client() {
    return this.connection.client;
  }

  shutdown() {
    this.emit('debug', `[WS] shutdown requested`);
    this.dead = true;
    this.reset();
  }

  /**
   * Resets the current WebSocket.
   */
  reset() {
    this.emit('debug', `[WS] reset requested`);
    if (this.ws) {
      if (this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
      this.ws = null;
    }
    this.clearHeartbeat();
  }

  /**
   * Starts connecting to the Voice WebSocket Server.
   */
  connect() {
    this.emit('debug', `[WS] connect requested`);
    if (this.dead) return;
    if (this.ws) this.reset();
    if (this.attempts >= 5) {
      // Bản port chỉ `debug` ở đây, nên promise của caller không bao giờ settle.
      this.emit('error', new Error(`VOICE_CONNECTION_ATTEMPTS_EXCEEDED after ${this.attempts} attempts`));
      return;
    }

    this.attempts++;

    /**
     * The actual WebSocket used to connect to the Voice WebSocket Server.
     * @type {WebSocket}
     */
    this.ws = WebSocket.create(`wss://${this.connection.authentication.endpoint}/`, { v: 8 });
    this.emit('debug', `[WS] connecting, ${this.attempts} attempts, ${this.ws.url}`);
    this.ws.onopen = this.onOpen.bind(this);
    this.ws.onmessage = this.onMessage.bind(this);
    this.ws.onclose = this.onClose.bind(this);
    this.ws.onerror = this.onError.bind(this);
  }

  /**
   * Sends data to the WebSocket if it is open.
   * @param {string|Buffer} data The data to send to the WebSocket
   * @param {string} [description] Mô tả cho log, vì Buffer in ra thì vô nghĩa
   * @returns {Promise<string>}
   */
  send(data, description = data) {
    this.emit('debug', `[WS] >> ${description}`);
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WS_NOT_OPEN', data);
      this.ws.send(data, null, error => {
        if (error) reject(error);
        else resolve(data);
      });
    });
  }

  /**
   * Gửi một frame nhị phân của DAVE.
   * @param {number} op Opcode
   * @param {Buffer} payload Nội dung
   * @returns {Promise<string>}
   */
  sendBinary(op, payload) {
    return this.send(WebSocket.packBinary(op, payload), `binary op ${op}, ${payload.length} bytes`);
  }

  /**
   * JSON.stringify's a packet and then sends it to the WebSocket Server.
   * @param {Object} packet The packet to send
   * @returns {Promise<string>}
   */
  async sendPacket(packet) {
    // IDENTIFY mang voice token; log phải che nó.
    return this.send(JSON.stringify(packet), stringifyRedacted(packet));
  }

  /**
   * Called whenever the WebSocket opens.
   */
  onOpen() {
    this.emit('debug', `[WS] opened at gateway ${this.connection.authentication.endpoint}`);
    this.sendPacket({
      op: VoiceOpcodes.IDENTIFY,
      d: {
        server_id: this.connection.serverId || this.connection.channel.guild?.id || this.connection.channel.id,
        channel_id: this.connection.channel.id,
        user_id: this.client.user.id,
        token: this.connection.authentication.token,
        session_id: this.connection.authentication.sessionId,
        // Khai 0, hoặc bỏ trống, thì Discord đóng bằng 4017. Đây chính là lý do
        // voice của bản port chưa bao giờ vào được kênh.
        max_dave_protocol_version: DAVE_PROTOCOL_VERSION,
        // `streams` và `video` là payload riêng của Go Live. Chỉ `StreamConnection`
        // khai, xem `VoiceConnection#identifyExtras`.
        ...this.connection.identifyExtras,
      },
    }).catch(() => {
      this.emit('error', new Error('VOICE_JOIN_SOCKET_CLOSED'));
    });
  }

  /**
   * Called whenever a message is received from the WebSocket.
   * @param {MessageEvent} event The message event that was received
   * @returns {void}
   */
  onMessage(event) {
    try {
      const packet = WebSocket.unpack(event.data);
      // `ws` trả chuỗi cho frame text và Buffer cho frame nhị phân. DAVE là loại thứ hai.
      return typeof event.data === 'string' ? this.onPacket(packet) : this.onBinaryPacket(packet);
    } catch (error) {
      return this.onError(error);
    }
  }

  /**
   * Called whenever a binary DAVE frame is received.
   * @param {Object} frame The parsed frame
   */
  onBinaryPacket({ op, seq, payload }) {
    if (seq) this._sequenceNumber = seq;
    this.emit('debug', `[WS] << binary op ${op}, ${payload.length} bytes`);
    /**
     * Emitted whenever a binary DAVE frame is received.
     * @param {Object} frame
     * @event VoiceWebSocket#daveBinary
     */
    this.emit('daveBinary', { op, payload });
  }

  /**
   * Called whenever the connection to the WebSocket server is lost.
   * @param {CloseEvent} event The WebSocket close event
   */
  onClose(event) {
    this.emit('debug', `[WS] closed with code ${event.code} and reason: ${event.reason}`);
    if (this.dead) return;

    const fatal = FATAL_CLOSE_CODES.get(event.code);
    if (fatal) {
      this.emit('error', new Error(`Voice websocket closed with ${event.code}: ${event.reason || fatal}`));
      return;
    }

    if (event.code === DISCONNECTED_CLOSE_CODE) return;

    setTimeout(this.connect.bind(this), this.attempts * 1000).unref();
  }

  /**
   * Called whenever an error occurs with the WebSocket.
   * @param {Error} error The error that occurred
   */
  onError(error) {
    this.emit('debug', `[WS] Error: ${error}`);
    this.emit('error', error);
  }

  /**
   * Called whenever a valid packet is received from the WebSocket.
   * @param {Object} packet The received packet
   */
  onPacket(packet) {
    this.emit('debug', `[WS] << ${stringifyRedacted(packet)}`);
    if (packet.seq) this._sequenceNumber = packet.seq;
    switch (packet.op) {
      case VoiceOpcodes.HELLO:
        this.setHeartbeat(packet.d.heartbeat_interval);
        break;
      case VoiceOpcodes.READY:
        /**
         * Emitted once the voice WebSocket receives the ready packet.
         * @param {Object} packet The received packet
         * @event VoiceWebSocket#ready
         */
        this.emit('ready', packet.d);
        this.connection.setVideoStatus(false);
        break;
      /* eslint-disable no-case-declarations */
      case VoiceOpcodes.SESSION_DESCRIPTION:
        packet.d.secret_key = new Uint8Array(packet.d.secret_key);
        /**
         * Emitted once the Voice Websocket receives a description of this voice session.
         * @param {Object} packet The received packet
         * @event VoiceWebSocket#sessionDescription
         */
        this.emit('sessionDescription', packet.d);
        break;
      case VoiceOpcodes.CLIENT_CONNECT:
        this.connection.ssrcMap.set(+packet.d.audio_ssrc, {
          userId: packet.d.user_id,
          speaking: 0,
          hasVideo: Boolean(packet.d.video_ssrc),
        });
        break;
      case VoiceOpcodes.CLIENTS_CONNECT:
        for (const id of packet.d.user_ids) this.connectedClients.add(id);
        break;
      case VoiceOpcodes.CLIENT_DISCONNECT:
        this.connectedClients.delete(packet.d.user_id);
        const streamInfo = this.connection.receiver && this.connection.receiver.packets.streams.get(packet.d.user_id);
        if (streamInfo) {
          this.connection.receiver.packets.streams.delete(packet.d.user_id);
          streamInfo.stream.push(null);
        }
        break;
      case VoiceOpcodes.SPEAKING:
        /**
         * Emitted whenever a speaking packet is received.
         * @param {Object} data
         * @event VoiceWebSocket#startSpeaking
         */
        this.emit('startSpeaking', packet.d);
        break;
      case VoiceOpcodes.SOURCES:
        /**
         * Emitted whenever a streaming packet is received.
         * @param {Object} data
         * @event VoiceWebSocket#startStreaming
         */
        this.emit('startStreaming', packet.d);
        break;
      case VoiceOpcodes.DAVE_PREPARE_TRANSITION:
      case VoiceOpcodes.DAVE_EXECUTE_TRANSITION:
      case VoiceOpcodes.DAVE_PREPARE_EPOCH:
        /**
         * Emitted whenever a JSON DAVE packet is received.
         * @param {Object} packet
         * @event VoiceWebSocket#daveMessage
         */
        this.emit('daveMessage', packet);
        break;
      default:
        /**
         * Emitted when an unhandled packet is received.
         * @param {Object} packet
         * @event VoiceWebSocket#unknownPacket
         */
        this.emit('unknownPacket', packet);
        break;
    }
  }

  /**
   * Sets an interval at which to send a heartbeat packet to the WebSocket.
   * @param {number} interval The interval at which to send a heartbeat packet
   */
  setHeartbeat(interval) {
    if (!interval || isNaN(interval)) {
      this.onError(new Error('VOICE_INVALID_HEARTBEAT'));
      return;
    }
    if (this.heartbeatInterval) {
      /**
       * Emitted whenever the voice WebSocket encounters a non-fatal error.
       * @param {string} warn The warning
       * @event VoiceWebSocket#warn
       */
      this.emit('warn', 'A voice heartbeat interval is being overwritten');
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = setInterval(this.sendHeartbeat.bind(this), interval).unref();
  }

  /**
   * Clears a heartbeat interval, if one exists.
   */
  clearHeartbeat() {
    if (!this.heartbeatInterval) {
      this.emit('warn', 'Tried to clear a heartbeat interval that does not exist');
      return;
    }
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }

  /**
   * Sends a heartbeat packet.
   */
  sendHeartbeat() {
    this.sendPacket({
      op: VoiceOpcodes.HEARTBEAT,
      d: {
        t: Date.now(),
        seq_ack: this._sequenceNumber,
      },
    }).catch(() => {
      this.emit('warn', 'Tried to send heartbeat, but connection is not open');
      this.clearHeartbeat();
    });
  }
}

module.exports = VoiceWebSocket;
