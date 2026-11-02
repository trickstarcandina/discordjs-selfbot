'use strict';

const EventEmitter = require('events');
const { getCiphers } = require('node:crypto');
const { setTimeout } = require('node:timers');
const { Collection } = require('@discordjs/collection');
const { ChannelType } = require('discord-api-types/v10');
const { DAVESession } = require('./networking/DAVESession');
const VoiceUDP = require('./networking/VoiceUDPClient');
const VoiceWebSocket = require('./networking/VoiceWebSocket');
const MediaPlayer = require('./player/MediaPlayer');
const VoiceReceiver = require('./receiver/Receiver');
const { parseStreamKey } = require('./util/Function');
const { mergeDefault } = require('./util/MergeDefault');
const PlayInterface = require('./util/PlayInterface');
const { REDACTED, stringifyRedacted } = require('./util/Redact');
const Silence = require('./util/Silence');
const { Opcodes, VoiceOpcodes, VoiceStatus } = require('./util/VoiceConstants');
const Events = require('../../util/Events');
const Speaking = require('../../util/SpeakingBitField');

// Workaround for Discord now requiring silence to be sent before being able to receive audio
class SingleSilence extends Silence {
  _read() {
    super._read();
    this.push(null);
  }
}

const SUPPORTED_MODES = ['aead_xchacha20_poly1305_rtpsize'];

// Just in case there's some system that doesn't come with aes-256-gcm, conditionally add it as supported
if (getCiphers().includes('aes-256-gcm')) {
  SUPPORTED_MODES.unshift('aead_aes256_gcm_rtpsize');
}

const SUPPORTED_CODECS = ['VP8', 'H264'];

/**
 * Payload mà Go Live nhét thêm vào IDENTIFY.
 *
 * Bản port cũ gửi nó trong **mọi** IDENTIFY, kể cả voice thường, thứ Discord không
 * hề đòi. Trả về object mới mỗi lần để không ai sửa được bản dùng chung.
 * @returns {Object}
 */
function goLiveIdentifyExtras() {
  return {
    streams: [{ type: 'screen', rid: '100', quality: 100 }],
    video: true,
  };
}

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => {
 *
 *   });
 * ```
 * @extends {EventEmitter}
 * @implements {PlayInterface}
 */
class VoiceConnection extends EventEmitter {
  constructor(voiceManager, channel) {
    super();

    /**
     * The voice manager that instantiated this connection
     * @type {ClientVoiceManager}
     */
    this.voiceManager = voiceManager;

    /**
     * The voice channel this connection is currently serving
     * @type {VoiceChannel}
     */
    this.channel = channel;

    /**
     * The current status of the voice connection
     * @type {VoiceStatus}
     */
    this.status = VoiceStatus.AUTHENTICATING;

    /**
     * Our current speaking state
     * @type {Readonly<Speaking>}
     */
    this.speaking = new Speaking().freeze();

    /**
     * Our current video state
     * @type {boolean | null}
     */
    this.videoStatus = null;

    /**
     * The authentication data needed to connect to the voice server
     * @type {Object}
     * @private
     */
    this.authentication = {};

    /**
     * The audio player for this voice connection
     * @type {MediaPlayer}
     */
    this.player = new MediaPlayer(this, this.constructor.name === 'StreamConnection');

    this.player.on('debug', m => {
      /**
       * Debug info from the connection.
       * @event VoiceConnection#debug
       * @param {string} message The debug message
       */
      this.emit('debug', `media player - ${m}`);
    });

    this.player.on('error', e => {
      /**
       * Warning info from the connection.
       * @event VoiceConnection#warn
       * @param {string|Error} warning The warning
       */
      this.emit('warn', e);
    });

    this.once('closing', () => this.player.destroy());

    /**
     * Map SSRC values to user IDs
     * @type {Map<number, { userId: Snowflake, speaking: boolean, hasVideo: boolean }>}
     * @private
     */
    this.ssrcMap = new Map();

    /**
     * Phiên DAVE của kết nối này, `null` khi voice server khai phiên bản 0.
     * @type {?DAVESession}
     */
    this.dave = null;

    /**
     * Tracks which users are talking
     * @type {Map<Snowflake, Readonly<Speaking>>}
     * @private
     */
    this._speaking = new Map();

    /**
     * Object that wraps contains the `ws` and `udp` sockets of this voice connection
     * @type {Object}
     * @private
     */
    this.sockets = {};

    /**
     * The voice receiver of this connection
     * @type {VoiceReceiver}
     */
    this.receiver = new VoiceReceiver(this);

    /**
     * Video codec
     * * `VP8`
     * * `VP9` (Not supported for encoding & decoding)
     * * `H264`
     * * `H265` (Not supported for encoding & decoding)
     * * `AV1` (Not supported for encoding & decoding)
     * @typedef {string} VideoCodec
     */

    /**
     * Video codec (encoded) of this connection
     * @type {VideoCodec}
     */
    this.videoCodec = 'H264';

    /**
     * Create a stream connection ?
     * @type {?StreamConnection}
     */
    this.streamConnection = null;

    /**
     * All stream watch connection
     * @type {Collection<Snowflake, StreamConnectionReadonly>}
     */
    this.streamWatchConnection = new Collection();
  }

  /**
   * The client that instantiated this connection
   * @type {Client}
   * @readonly
   */
  get client() {
    return this.voiceManager.client;
  }

  /**
   * The current audio dispatcher (if any)
   * @type {?AudioDispatcher}
   * @readonly
   */
  get dispatcher() {
    return this.player.dispatcher;
  }

  /**
   * The current video dispatcher (if any)
   * @type {?VideoDispatcher}
   * @readonly
   */
  get videoDispatcher() {
    return this.player.videoDispatcher;
  }

  /**
   * Sets whether the voice connection should display as "speaking", "soundshare" or "none".
   * @param {BitFieldResolvable} value The new speaking state
   */
  setSpeaking(value) {
    if (this.speaking.equals(value)) return;
    if (this.status !== VoiceStatus.CONNECTED) return;
    this.speaking = new Speaking(value).freeze();
    this.sockets.ws
      .sendPacket({
        op: VoiceOpcodes.SPEAKING,
        d: {
          speaking: this.speaking.bitfield,
          delay: 0,
          ssrc: this.authentication.ssrc,
        },
      })
      .catch(e => {
        this.emit('debug', e);
      });
  }

  /**
   * Set video codec before select protocol
   * @param {VideoCodec} value Codec
   * @returns {VoiceConnection}
   */
  setVideoCodec(value) {
    if (!SUPPORTED_CODECS.includes(value)) throw new Error('INVALID_VIDEO_CODEC', SUPPORTED_CODECS);
    this.videoCodec = value;
    return this;
  }

  /**
   * Sets video status
   * @param {boolean} value Video on or off
   */
  setVideoStatus(value) {
    if (value === this.videoStatus) return;
    if (this.status !== VoiceStatus.CONNECTED) return;
    this.videoStatus = value;
    if (!value) {
      this.sockets.ws
        .sendPacket({
          op: VoiceOpcodes.SOURCES,
          d: {
            audio_ssrc: this.authentication.ssrc,
            video_ssrc: 0,
            rtx_ssrc: 0,
            streams: [],
          },
        })
        .catch(e => {
          this.emit('debug', e);
        });
    } else {
      this.sockets.ws
        .sendPacket({
          op: VoiceOpcodes.SOURCES,
          d: {
            audio_ssrc: this.authentication.ssrc,
            video_ssrc: this.authentication.ssrc + 1,
            rtx_ssrc: this.authentication.ssrc + 2,
            streams: [
              {
                type: 'video',
                rid: '100',
                ssrc: this.authentication.ssrc + 1,
                active: true,
                quality: 100,
                rtx_ssrc: this.authentication.ssrc + 2,
                max_bitrate: 8000000,
                max_framerate: 60,
                max_resolution: {
                  type: 'source',
                  width: 0,
                  height: 0,
                },
              },
            ],
          },
        })
        .catch(e => {
          this.emit('debug', e);
        });
    }
  }

  /**
   * The voice state of this connection
   * @type {?VoiceState}
   */
  get voice() {
    return this.client.user.voice;
  }

  /**
   * Sends a request to the main gateway to join a voice channel.
   * @param {Object} [options] The options to provide
   * @returns {Promise<Shard>}
   * @private
   */
  sendVoiceStateUpdate(options = {}) {
    options = mergeDefault(
      {
        guild_id: this.channel.guild?.id || null,
        channel_id: this.channel.id,
        self_mute: this.voice ? this.voice.selfMute : false,
        self_deaf: this.voice ? this.voice.selfDeaf : false,
        self_video: this.voice ? this.voice.selfVideo : false,
        flags: 2,
      },
      options,
    );

    this.emit('debug', `Sending voice state update: ${JSON.stringify(options)}`);

    return this.channel.client.ws.broadcast({
      op: Opcodes.VOICE_STATE_UPDATE,
      d: options,
    });
  }

  /**
   * Set the token and endpoint required to connect to the voice servers.
   * @param {string} token The voice token
   * @param {string} endpoint The voice endpoint
   * @returns {void}
   * @private
   */
  setTokenAndEndpoint(token, endpoint) {
    this.emit('debug', `Token ${token ? REDACTED : '(none)'} and endpoint "${endpoint}"`);
    if (!endpoint) {
      // Signifies awaiting endpoint stage
      return;
    }

    if (!token) {
      this.authenticateFailed('VOICE_TOKEN_ABSENT');
      return;
    }

    // Discord trả endpoint kèm cổng. Bản v13 cắt phăng cổng vì thời đó Discord gắn
    // `:80`, thứ không dùng được cho `wss`. Giờ nó trả `:8443` thật, và cắt đi là
    // nối vào cổng 443 của một tiến trình voice khác — tiến trình đó không giữ
    // session của ta nên đóng ngay bằng `4006 Session is no longer valid`. Chỉ bỏ
    // đúng cái cổng vô nghĩa cũ, giữ nguyên phần còn lại.
    endpoint = endpoint.replace(/:80$/, '');
    this.emit('debug', `Endpoint resolved as ${endpoint}`);

    if (!endpoint) {
      this.authenticateFailed('VOICE_INVALID_ENDPOINT');
      return;
    }

    if (this.status === VoiceStatus.AUTHENTICATING) {
      this.authentication.token = token;
      this.authentication.endpoint = endpoint;
      this.checkAuthenticated();
    } else if (token !== this.authentication.token || endpoint !== this.authentication.endpoint) {
      this.reconnect(token, endpoint);
    }
  }

  /**
   * Sets the Session ID for the connection.
   * @param {string} sessionId The voice session ID
   * @private
   */
  setSessionId(sessionId) {
    this.emit(
      'debug',
      `Setting sessionId ${sessionId ? REDACTED : '(none)'} (stored: ${this.authentication.sessionId ? 'yes' : 'no'})`,
    );
    if (!sessionId) {
      this.authenticateFailed('VOICE_SESSION_ABSENT');
      return;
    }

    if (this.status === VoiceStatus.AUTHENTICATING) {
      this.authentication.sessionId = sessionId;
      this.checkAuthenticated();
    } else if (sessionId !== this.authentication.sessionId) {
      this.authentication.sessionId = sessionId;
      /**
       * Emitted when a new session ID is received.
       * @event VoiceConnection#newSession
       * @private
       */
      this.emit('newSession', sessionId);
    }
  }

  /**
   * Checks whether the voice connection is authenticated.
   * @private
   */
  checkAuthenticated() {
    const { token, endpoint, sessionId } = this.authentication;
    this.emit('debug', `Authenticated with sessionId ${sessionId ? REDACTED : '(none)'}`);
    if (token && endpoint && sessionId) {
      this.status = VoiceStatus.CONNECTING;
      /**
       * Emitted when we successfully initiate a voice connection.
       * @event VoiceConnection#authenticated
       */
      this.emit('authenticated');
      this.connect();
    }
  }

  /**
   * Invoked when we fail to initiate a voice connection.
   * @param {string} reason The reason for failure
   * @private
   */
  authenticateFailed(reason) {
    clearTimeout(this.connectTimeout);
    this.emit('debug', `Authenticate failed - ${reason}`);
    if (this.status === VoiceStatus.AUTHENTICATING) {
      /**
       * Emitted when we fail to initiate a voice connection.
       * @event VoiceConnection#failed
       * @param {Error} error The encountered error
       */
      this.emit('failed', new Error(reason));
    } else {
      /**
       * Emitted whenever the connection encounters an error.
       * @event VoiceConnection#error
       * @param {Error} error The encountered error
       */
      this.emit('error', new Error(reason));
    }
    this.status = VoiceStatus.DISCONNECTED;
  }

  /**
   * Move to a different voice channel in the same guild.
   * @param {VoiceChannel} channel The channel to move to
   * @private
   */
  updateChannel(channel) {
    this.channel = channel;
    this.sendVoiceStateUpdate();
  }

  /**
   * Attempts to authenticate to the voice server.
   * @param {Object} options Join config
   * @private
   */
  authenticate(options = {}) {
    this.sendVoiceStateUpdate(options);
    this.connectTimeout = setTimeout(() => this.authenticateFailed('VOICE_CONNECTION_TIMEOUT'), 15_000).unref();
  }

  /**
   * Attempts to reconnect to the voice server (typically after a region change).
   * @param {string} token The voice token
   * @param {string} endpoint The voice endpoint
   * @private
   */
  reconnect(token, endpoint) {
    this.authentication.token = token;
    this.authentication.endpoint = endpoint;
    this.speaking = new Speaking().freeze();
    this.status = VoiceStatus.RECONNECTING;
    this.emit('debug', `Reconnecting to ${endpoint}`);
    /**
     * Emitted when the voice connection is reconnecting (typically after a region change).
     * @event VoiceConnection#reconnecting
     */
    this.emit('reconnecting');
    this.connect();
  }

  /**
   * Disconnects the voice connection, causing a disconnect and closing event to be emitted.
   */
  disconnect() {
    this.emit('closing');
    this.emit('debug', 'disconnect() triggered');
    clearTimeout(this.connectTimeout);
    const conn = this.voiceManager.connection;
    if (conn === this) this.voiceManager.connection = null;
    this.sendVoiceStateUpdate({
      channel_id: null,
    });
    this._disconnect();
  }

  /**
   * Internally disconnects (doesn't send disconnect packet).
   * @private
   */
  _disconnect() {
    this.cleanup();
    this.status = VoiceStatus.DISCONNECTED;
    /**
     * Emitted when the voice connection disconnects.
     * @event VoiceConnection#disconnect
     */
    this.emit('disconnect');
  }

  /**
   * Cleans up after disconnect.
   * @private
   */
  cleanup() {
    this.player.destroy();
    this.speaking = new Speaking().freeze();
    const { ws, udp } = this.sockets;

    this.emit('debug', 'Connection clean up');

    this.dave?.destroy();
    this.dave = null;

    if (ws) {
      ws.removeAllListeners('error');
      ws.removeAllListeners('ready');
      ws.removeAllListeners('sessionDescription');
      ws.removeAllListeners('speaking');
      ws.removeAllListeners('daveMessage');
      ws.removeAllListeners('daveBinary');
      ws.shutdown();
    }

    if (udp) udp.removeAllListeners('error');

    this.sockets.ws = null;
    this.sockets.udp = null;
  }

  /**
   * Connect the voice connection.
   * @private
   */
  connect() {
    this.emit('debug', `Connect triggered`);
    if (this.status !== VoiceStatus.RECONNECTING) {
      if (this.sockets.ws) throw new Error('WS_CONNECTION_EXISTS');
      if (this.sockets.udp) throw new Error('UDP_CONNECTION_EXISTS');
    }

    if (this.sockets.ws) this.sockets.ws.shutdown();
    if (this.sockets.udp) this.sockets.udp.shutdown();

    this.sockets.ws = new VoiceWebSocket(this);
    this.sockets.udp = new VoiceUDP(this);

    const { ws, udp } = this.sockets;

    ws.on('debug', msg => this.emit('debug', msg));
    udp.on('debug', msg => this.emit('debug', msg));
    ws.on('error', err => this.emit('error', err));
    udp.on('error', err => this.emit('error', err));
    ws.on('ready', this.onReady.bind(this));
    ws.on('sessionDescription', this.onSessionDescription.bind(this));
    ws.on('startSpeaking', this.onStartSpeaking.bind(this));
    ws.on('startStreaming', this.onStartStreaming.bind(this));
    ws.on('daveMessage', this.onDaveMessage.bind(this));
    ws.on('daveBinary', this.onDaveBinary.bind(this));

    this.sockets.ws.connect();
  }

  /**
   * Invoked when the voice websocket is ready.
   * @param {Object} data The received data
   * @private
   */
  onReady(data) {
    Object.assign(this.authentication, data);
    for (let mode of data.modes) {
      if (SUPPORTED_MODES.includes(mode)) {
        this.authentication.mode = mode;
        this.emit('debug', `Selecting the ${mode} mode`);
        break;
      }
    }
    this.sockets.udp.createUDPSocket(data.ip);
  }

  /**
   * Invoked when a session description is received.
   * @param {Object} data The received data
   * @private
   */
  onSessionDescription(data) {
    Object.assign(this.authentication, data);

    // Voice server khai phiên bản DAVE ở đây, cạnh `mode` và `secret_key` — không
    // phải ở READY.
    this.dave?.destroy();
    this.dave = this.createDaveSession(data.dave_protocol_version);

    this.status = VoiceStatus.CONNECTED;
    const ready = () => {
      clearTimeout(this.connectTimeout);
      this.emit('debug', `Ready with authentication details: ${stringifyRedacted(this.authentication)}`);
      /**
       * Emitted once the connection is ready, when a promise to join a voice channel resolves,
       * the connection will already be ready.
       * @event VoiceConnection#ready
       */
      this.emit('ready');
    };
    if (this.dispatcher || this.videoDispatcher) {
      ready();
    } else {
      // This serves to provide support for voice receive, sending audio is required to receive it.
      const dispatcher = this.playAudio(new SingleSilence(), { type: 'opus', volume: false });
      dispatcher.once('finish', ready);
    }
  }

  /**
   * Field riêng nhét thêm vào IDENTIFY.
   *
   * Voice thường không có gì. `StreamConnection` mới cần `streams` và `video`, và
   * bản port cũ gửi chúng trong mọi IDENTIFY — Discord không hề đòi thứ đó cho một
   * kết nối voice bình thường.
   * @type {Object}
   * @readonly
   * @private
   */
  get identifyExtras() {
    return {};
  }

  /**
   * Tạo phiên DAVE theo phiên bản voice server khai trong SESSION_DESCRIPTION.
   * @param {number} protocolVersion Phiên bản giao thức
   * @returns {?DAVESession}
   * @private
   */
  createDaveSession(protocolVersion) {
    if (!protocolVersion) return null;

    const dave = new DAVESession(protocolVersion, this.client.user.id, this.channel.id);
    dave.on('debug', message => this.emit('debug', `[DAVE] ${message}`));
    dave.on('error', error => this.emit('error', error));
    dave.on('keyPackage', keyPackage =>
      this.sockets.ws?.sendBinary(VoiceOpcodes.DAVE_MLS_KEY_PACKAGE, keyPackage).catch(() => null),
    );
    dave.on('invalidateTransition', transitionId =>
      this.sockets.ws
        ?.sendPacket({
          op: VoiceOpcodes.DAVE_MLS_INVALID_COMMIT_WELCOME,
          d: { transition_id: transitionId },
        })
        .catch(() => null),
    );

    // Khởi tạo ngay, đừng đợi opcode 24. Voice server gửi external sender (25) và
    // proposals (27) trước khi báo epoch, nên hoãn tới `prepareEpoch` là gặp
    // "No session available" — đo được ở region Nhật, nơi bắt tay thật sự chạy tới
    // bước này.
    dave.reinit();

    return dave;
  }

  /**
   * Xử lý opcode DAVE dạng JSON.
   * @param {Object} packet Gói nhận được
   * @private
   */
  onDaveMessage(packet) {
    if (!this.dave) return;

    if (packet.op === VoiceOpcodes.DAVE_PREPARE_TRANSITION) {
      if (this.dave.prepareTransition(packet.d)) this._sendTransitionReady(packet.d.transition_id);
    } else if (packet.op === VoiceOpcodes.DAVE_EXECUTE_TRANSITION) {
      this.dave.executeTransition(packet.d.transition_id);
    } else if (packet.op === VoiceOpcodes.DAVE_PREPARE_EPOCH) {
      this.dave.prepareEpoch(packet.d);
    }
  }

  /**
   * Xử lý frame DAVE dạng nhị phân.
   * @param {Object} frame Frame nhận được
   * @private
   */
  onDaveBinary({ op, payload }) {
    if (!this.dave) return;

    if (op === VoiceOpcodes.DAVE_MLS_EXTERNAL_SENDER) {
      this.dave.setExternalSender(payload);
    } else if (op === VoiceOpcodes.DAVE_MLS_PROPOSALS) {
      const response = this.dave.processProposals(payload, this.sockets.ws.connectedClients);
      if (response) this.sockets.ws.sendBinary(VoiceOpcodes.DAVE_MLS_COMMIT_WELCOME, response).catch(() => null);
    } else if (op === VoiceOpcodes.DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION) {
      const { transitionId, success } = this.dave.processCommit(payload);
      if (success && transitionId !== 0) this._sendTransitionReady(transitionId);
    } else if (op === VoiceOpcodes.DAVE_MLS_WELCOME) {
      const { transitionId, success } = this.dave.processWelcome(payload);
      if (success && transitionId !== 0) this._sendTransitionReady(transitionId);
    }
  }

  /**
   * @param {number} transitionId Transition đã sẵn sàng
   * @private
   */
  _sendTransitionReady(transitionId) {
    this.sockets.ws
      ?.sendPacket({ op: VoiceOpcodes.DAVE_TRANSITION_READY, d: { transition_id: transitionId } })
      .catch(() => null);
  }

  onStartSpeaking({ user_id, ssrc, speaking }) {
    this.ssrcMap.set(+ssrc, {
      ...(this.ssrcMap.get(+ssrc) || {}),
      userId: user_id,
      speaking: speaking,
    });
  }

  onStartStreaming({ video_ssrc, user_id, audio_ssrc }) {
    this.ssrcMap.set(+audio_ssrc, {
      ...(this.ssrcMap.get(+audio_ssrc) || {}),
      userId: user_id,
      hasVideo: Boolean(video_ssrc), // Maybe ?
    });
    /**
{
  video_ssrc: 0,
  user_id: 'uid',
  streams: [
    {
      ssrc: 27734,
      rtx_ssrc: 27735,
      rid: '100',
      quality: 100,
      max_resolution: { width: 0, type: 'source', height: 0 },,
      max_framerate: 60,
      active: false
    }
  ],
  audio_ssrc: 27733
}
     */
  }

  /**
   * Invoked when a speaking event is received.
   * @param {Object} data The received data
   * @private
   */
  onSpeaking({ user_id, speaking }) {
    speaking = new Speaking(speaking).freeze();
    const guild = this.channel.guild;
    const user = this.client.users.cache.get(user_id);
    const old = this._speaking.get(user_id) || new Speaking(0).freeze();
    this._speaking.set(user_id, speaking);
    /**
     * Emitted whenever a user changes speaking state.
     * @event VoiceConnection#speaking
     * @param {User} user The user that has changed speaking state
     * @param {Readonly<Speaking>} speaking The speaking state of the user
     */
    if (this.status === VoiceStatus.CONNECTED) {
      this.emit('speaking', user, speaking);
      if (!speaking.has(Speaking.Flags.Speaking)) {
        this.receiver.packets._stoppedSpeaking(user_id);
      }
    }

    if (guild && user && !speaking.equals(old)) {
      const member = guild.members.cache.get(user);
      if (member) {
        /**
         * Emitted once a guild member changes speaking state.
         * @event Client#guildMemberSpeaking
         * @param {GuildMember} member The member that started/stopped speaking
         * @param {Readonly<Speaking>} speaking The speaking state of the member
         */
        this.client.emit(Events.GuildMemberSpeaking, member, speaking);
      }
    }
  }

  playAudio() {} // eslint-disable-line no-empty-function
  playVideo() {} // eslint-disable-line no-empty-function

  /**
   * Create new connection to screenshare stream
   * @returns {Promise<StreamConnection>}
   */
  createStreamConnection() {
    // eslint-disable-next-line consistent-return
    return new Promise((resolve, reject) => {
      if (this.streamConnection) {
        return resolve(this.streamConnection);
      } else {
        const connection = (this.streamConnection = new StreamConnection(this.voiceManager, this.channel, this));
        connection.setVideoCodec(this.videoCodec); // Sync :?
        // Setup event...
        if (!this.eventHook) {
          this.eventHook = true; // Dont listen this event two times :/
          this.channel.client.on('raw', packet => {
            if (typeof packet !== 'object' || !packet.t || !packet.d || !packet.d?.stream_key) {
              return;
            }
            const { t: event, d: data } = packet;
            const StreamKey = parseStreamKey(data.stream_key);
            if (
              StreamKey.userId === this.channel.client.user.id &&
              this.channel.id == StreamKey.channelId &&
              this.streamConnection
            ) {
              // Current user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  this.streamConnection.setSessionId(this.authentication.sessionId);
                  this.streamConnection.serverId = data.rtc_server_id;
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  this.streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  this.streamConnection.disconnect();
                  break;
                }
                case 'STREAM_UPDATE': {
                  this.streamConnection.update(data);
                  break;
                }
              }
            }
            if (this.streamWatchConnection.has(StreamKey.userId) && this.channel.id == StreamKey.channelId) {
              const streamConnection = this.streamWatchConnection.get(StreamKey.userId);
              // Watch user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  streamConnection.setSessionId(this.authentication.sessionId);
                  streamConnection.serverId = data.rtc_server_id;
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  streamConnection.disconnect();
                  streamConnection.receiver.packets.destroyAllStream();
                  break;
                }
                case 'STREAM_UPDATE': {
                  streamConnection.update(data);
                  break;
                }
              }
            }
          });
        }

        connection.sendSignalScreenshare();
        connection.sendScreenshareState(true);

        connection.on('debug', msg =>
          this.channel.client.emit(
            'debug',
            `[VOICE STREAM (${this.channel.guild?.id || this.channel.id}:${connection.status})]: ${msg}`,
          ),
        );
        connection.once('failed', reason => {
          this.streamConnection = null;
          reject(reason);
        });

        connection.on('error', reject);

        connection.once('authenticated', () => {
          connection.once('ready', () => {
            resolve(connection);
            connection.removeListener('error', reject);
          });
          connection.once('disconnect', () => {
            this.streamConnection = null;
          });
        });
      }
    });
  }

  /**
   * Watch user stream
   * @param {UserResolvable} user Discord user
   * @returns {Promise<StreamConnectionReadonly>}
   */
  async joinStreamConnection(user) {
    const userId = this.client.users.resolveId(user);
    // Check if user is streaming
    if (!userId) {
      throw new Error('VOICE_USER_MISSING');
    }
    const voiceState = this.channel.guild?.voiceStates.cache.get(userId) || this.client.voiceStates.cache.get(userId);
    if (!voiceState || !voiceState.streaming) {
      throw new Error('VOICE_USER_NOT_STREAMING');
    }
    // eslint-disable-next-line consistent-return
    return new Promise((resolve, reject) => {
      if (this.streamWatchConnection.has(userId)) {
        return resolve(this.streamWatchConnection.get(userId));
      } else {
        const connection = new StreamConnectionReadonly(this.voiceManager, this.channel, this, userId);
        this.streamWatchConnection.set(userId, connection);
        connection.setVideoCodec(this.videoCodec);
        // Setup event...
        if (!this.eventHook) {
          this.eventHook = true; // Dont listen this event two times :/
          this.channel.client.on('raw', packet => {
            if (typeof packet !== 'object' || !packet.t || !packet.d || !packet.d?.stream_key) {
              return;
            }
            const { t: event, d: data } = packet;
            const StreamKey = parseStreamKey(data.stream_key);
            if (
              StreamKey.userId === this.channel.client.user.id &&
              this.channel.id == StreamKey.channelId &&
              this.streamConnection
            ) {
              // Current user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  this.streamConnection.setSessionId(this.authentication.sessionId);
                  this.streamConnection.serverId = data.rtc_server_id;
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  this.streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  this.streamConnection.disconnect();
                  break;
                }
                case 'STREAM_UPDATE': {
                  this.streamConnection.update(data);
                  break;
                }
              }
            }
            if (this.streamWatchConnection.has(StreamKey.userId) && this.channel.id == StreamKey.channelId) {
              const streamConnection = this.streamWatchConnection.get(StreamKey.userId);
              // Watch user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  streamConnection.setSessionId(this.authentication.sessionId);
                  streamConnection.serverId = data.rtc_server_id;
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  streamConnection.disconnect();
                  streamConnection.receiver.packets.destroyAllStream();
                  break;
                }
                case 'STREAM_UPDATE': {
                  streamConnection.update(data);
                  break;
                }
              }
            }
          });
        }

        connection.sendSignalScreenshare();

        connection.on('debug', msg =>
          this.channel.client.emit(
            'debug',
            `[VOICE STREAM WATCH (${userId}>${this.channel.guild?.id || this.channel.id}:${
              connection.status
            })]: ${msg}`,
          ),
        );
        connection.once('failed', reason => {
          this.streamWatchConnection.delete(userId);
          reject(reason);
        });

        connection.on('error', reject);

        connection.once('authenticated', () => {
          connection.once('ready', () => {
            resolve(connection);
            connection.removeListener('error', reject);
          });
          connection.once('disconnect', () => {
            this.streamWatchConnection.delete(userId);
          });
        });
      }
    });
  }

  /**
   * @event VoiceConnection#streamUpdate
   * @description Emitted when the StreamConnection or StreamConnectionReadonly
   * state changes, providing the previous and current stream state.
   *
   * @param {StreamState} oldData - The previous state of the stream.
   * @param {StreamState} newData - The current state of the stream.
   *
   * @typedef {Object} StreamState
   * @property {boolean} isPaused - Indicates whether the stream is currently paused.
   * @property {string|null} region - The region where the stream is hosted, or null if not specified.
   * @property {Snowflake[]} viewerIds - An array of Snowflake IDs representing the viewers connected to the stream.
   */
}

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => connection.createStreamConnection())
 *    .then(connection => {
 *
 *   });
 * ```
 * @extends {VoiceConnection}
 */
class StreamConnection extends VoiceConnection {
  #requestDisconnect = false;
  /**
   * @param {ClientVoiceManager} voiceManager Voice manager
   * @param {Channel} channel any channel (joinable)
   * @param {VoiceConnection} voiceConnection parent
   */
  constructor(voiceManager, channel, voiceConnection) {
    super(voiceManager, channel);

    /**
     * Current voice connection
     * @type {VoiceConnection}
     */
    this.voiceConnection = voiceConnection;

    Object.defineProperty(this, 'voiceConnection', {
      value: voiceConnection,
      writable: false,
    });

    /**
     * Server Id
     * @type {string | null}
     */
    this.serverId = null;

    /**
     * Stream state
     * @type {boolean | null}
     */
    this.isPaused = null;

    /**
     * Viewer IDs
     * @type {Snowflake[]}
     */
    this.viewerIds = [];

    /**
     * Voice region name
     * @type {string | null}
     */
    this.region = null;
  }

  createStreamConnection() {
    return Promise.resolve(this);
  }

  joinStreamConnection() {
    throw new Error('STREAM_CANNOT_JOIN');
  }

  /**
   * Go Live khai luồng ngay trong IDENTIFY.
   * @type {Object}
   * @readonly
   * @private
   */
  get identifyExtras() {
    return goLiveIdentifyExtras();
  }

  get streamConnection() {
    return this;
  }

  set streamConnection(value) {
    // Why ?
  }

  get streamWatchConnection() {
    return new Collection();
  }

  set streamWatchConnection(value) {
    // Why ?
  }

  disconnect() {
    if (this.#requestDisconnect) return;
    this.emit('closing');
    this.emit('debug', 'Stream: disconnect() triggered');
    clearTimeout(this.connectTimeout);
    if (this.voiceConnection.streamConnection === this) this.voiceConnection.streamConnection = null;
    this.sendStopScreenshare();
    this._disconnect();
  }

  /**
   * Create new stream connection (WS packet)
   * @returns {void}
   */
  sendSignalScreenshare() {
    const data = {
      type: isDMBasedChannel(this.channel) ? 'call' : 'guild',
      guild_id: this.channel.guild?.id || null,
      channel_id: this.channel.id,
      preferred_region: null,
    };
    this.emit('debug', `Signal Stream: ${JSON.stringify(data)}`);
    return this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_CREATE,
      d: data,
    });
  }

  /**
   * Send screenshare state... (WS)
   * @param {boolean} isPaused screenshare paused ?
   * @returns {void}
   */
  sendScreenshareState(isPaused = false) {
    if (isPaused == this.isPaused) return;
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds,
      },
      {
        isPaused,
        region: this.region,
        viewerIds: this.viewerIds,
      },
    );
    this.isPaused = isPaused;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_SET_PAUSED,
      d: {
        stream_key: this.streamKey,
        paused: isPaused,
      },
    });
  }

  /**
   * Stop screenshare, delete this connection (WS)
   * @returns {void}
   * @private Using StreamConnection#disconnect()
   */
  sendStopScreenshare() {
    this.#requestDisconnect = true;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_DELETE,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  update(data) {
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds.slice(),
      },
      {
        isPaused: data.paused,
        region: data.region,
        viewerIds: data.viewer_ids,
      },
    );
    this.viewerIds = data.viewer_ids;
    this.region = data.region;
  }

  /**
   * Current stream key
   * @type {string}
   */
  get streamKey() {
    return `${isDMBasedChannel(this.channel) ? 'call' : `guild:${this.channel.guild.id}`}:${
      this.channel.id
    }:${this.channel.client.user.id}`;
  }
}

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => connection.createStreamConnection())
 *    .then(connection => {
 *
 *   });
 * ```
 * @extends {VoiceConnection}
 */
class StreamConnectionReadonly extends VoiceConnection {
  #requestDisconnect = false;

  /**
   * Xem Go Live cũng đi qua luồng stream, nên giữ nguyên payload IDENTIFY mà bản
   * port vẫn gửi. Đường này chưa từng chạy được lần nào, nên không có gì để đối
   * chiếu nếu đổi — đổi ở đây là đoán mò, không phải sửa.
   * @type {Object}
   * @readonly
   * @private
   */
  get identifyExtras() {
    return goLiveIdentifyExtras();
  }

  /**
   * @param {ClientVoiceManager} voiceManager Voice manager
   * @param {Channel} channel any channel (joinable)
   * @param {VoiceConnection} voiceConnection parent
   * @param {Snowflake} userId User ID
   */
  constructor(voiceManager, channel, voiceConnection, userId) {
    super(voiceManager, channel);

    /**
     * Current voice connection
     * @type {VoiceConnection}
     */
    this.voiceConnection = voiceConnection;

    /**
     * User ID (who started the stream)
     * @type {Snowflake}
     */
    this.userId = userId;

    Object.defineProperty(this, 'voiceConnection', {
      value: voiceConnection,
      writable: false,
    });

    /**
     * Server Id
     * @type {string | null}
     */
    this.serverId = null;

    /**
     * Stream state
     * @type {boolean}
     */
    this.isPaused = false;

    /**
     * Viewer IDs
     * @type {Snowflake[]}
     */
    this.viewerIds = [];

    /**
     * Voice region name
     * @type {string | null}
     */
    this.region = null;
  }

  createStreamConnection() {
    throw new Error('STREAM_CONNECTION_READONLY');
  }

  joinStreamConnection() {
    return Promise.resolve(this);
  }

  get streamConnection() {
    return null;
  }

  set streamConnection(value) {
    // Why ?
  }

  get streamWatchConnection() {
    return new Collection();
  }

  set streamWatchConnection(value) {
    // Why ?
  }

  disconnect() {
    if (this.#requestDisconnect) return;
    this.emit('closing');
    this.emit('debug', 'Stream: disconnect() triggered');
    clearTimeout(this.connectTimeout);
    this.voiceConnection.streamWatchConnection.delete(this.userId);
    this.sendStopScreenshare();
    this._disconnect();
  }

  /**
   * Create new stream connection (WS packet)
   * @returns {void}
   */
  sendSignalScreenshare() {
    this.emit('debug', `Signal Stream Watch: ${this.streamKey}`);
    return this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_WATCH,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  /**
   * Stop screenshare, delete this connection (WS)
   * @returns {void}
   * @private Using StreamConnection#disconnect()
   */
  sendStopScreenshare() {
    this.#requestDisconnect = true;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_DELETE,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  update(data) {
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds.slice(),
      },
      {
        isPaused: data.paused,
        region: data.region,
        viewerIds: data.viewer_ids,
      },
    );
    this.isPaused = data.paused;
    this.viewerIds = data.viewer_ids;
    this.region = data.region;
  }

  /**
   * Current stream key
   * @type {string}
   */
  get streamKey() {
    return `${isDMBasedChannel(this.channel) ? 'call' : `guild:${this.channel.guild.id}`}:${
      this.channel.id
    }:${this.userId}`;
  }
}

PlayInterface.applyToClass(VoiceConnection);
PlayInterface.applyToClass(StreamConnection);

/**
 * Kênh này là DM hay group DM.
 *
 * Bản v13 so sánh `channel.type` với chuỗi `'DM'`/`'GROUP_DM'`; ở v14 field đó
 * là số nên so sánh cũ luôn sai, và sai im lặng — cuộc gọi bị coi là guild.
 * @param {?BaseChannel} channel Kênh cần kiểm tra
 * @returns {boolean}
 */
function isDMBasedChannel(channel) {
  return channel?.type === ChannelType.DM || channel?.type === ChannelType.GroupDM;
}

module.exports = VoiceConnection;
// `StreamConnection` vốn là lớp riêng của module. Gắn ra ngoài để test khoá được
// phần IDENTIFY của Go Live, thứ dễ hỏng nhất khi tách `streams` khỏi voice thường.
module.exports.StreamConnection = StreamConnection;
module.exports.StreamConnectionReadonly = StreamConnectionReadonly;
