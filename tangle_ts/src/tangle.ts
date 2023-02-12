import { PeerId, Room, RoomState } from "./room.js";
import { TimeMachine, FunctionCall } from "./time_machine";
import { RustUtilities } from "./rust_utilities.js";
import { MessageWriterReader } from "./message_encoding.js";

export { RoomState, PeerId } from "./room.js";

enum MessageType {
    WasmCall,
    TimeProgressed,
    RequestState,
    SetProgram,
    SetHeap,
    // Used to figure out roundtrip time.
    Ping,
    Pong
}

type PeerData = {
    last_sent_message: number,
    last_received_message: number,
    round_trip_time: number,
}

export enum TangleState {
    Disconnected,
    Connected,
    RequestingHeap
}

type TangleConfiguration = {
    fixed_update_interval?: number;
    accept_new_programs?: boolean,
    room_name?: string,
    on_state_change_callback?: (state: TangleState, tangle: Tangle) => void
}

class UserIdType { }
export const UserId = new UserIdType();

export class Tangle {
    private _room!: Room;
    private _time_machine!: TimeMachine;
    private _rust_utilities: RustUtilities;

    private _buffered_messages: Array<FunctionCall> = [];
    private _peer_data: Map<PeerId, PeerData> = new Map();
    private _tangle_state = TangleState.Disconnected;
    private _current_program_binary = new Uint8Array();
    private _block_reentrancy = false;
    private _enqueued_inner_calls: Array<() => void> = [];
    private _last_performance_now?: number;
    private _configuration: TangleConfiguration = {};
    private _outgoing_message_buffer = new Uint8Array(500);

    private _message_time_offset = 0;

    // private _debug_enabled = true;

    static async setup(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, tangle_configuration?: TangleConfiguration): Promise<Tangle> {
        tangle_configuration ??= {};
        tangle_configuration.accept_new_programs ??= false;
        tangle_configuration.fixed_update_interval ??= 0;

        const time_machine = await TimeMachine.setup(wasm_binary, wasm_imports, tangle_configuration.fixed_update_interval);

        const tangle = new Tangle(time_machine);
        tangle._configuration = tangle_configuration;
        await tangle.setup_inner(tangle_configuration.room_name, wasm_binary);
        return tangle;
    }

    constructor(time_machine: TimeMachine) {
        this._time_machine = time_machine;
        this._rust_utilities = time_machine.rust_utilities;
    }

    private _change_state(state: TangleState) {
        if (this._tangle_state != state) {
            if (this._tangle_state == TangleState.Connected) {
                this._last_performance_now = performance.now();
            }
            this._tangle_state = state;
            this._configuration.on_state_change_callback?.(state, this);
        }
        this._tangle_state = state
    }

    private async setup_inner(room_name: string | undefined, wasm_binary: Uint8Array) {
        room_name ??= document.location.href;

        // Append a hash of the binary so that peers won't join rooms without matching binaries.
        const hash = this._rust_utilities.hash_data(wasm_binary);
        room_name += hash.join("");

        const room_configuration = {
            room_name,
            on_peer_joined: (peer_id: PeerId) => {
                this._run_inner_function(async () => {
                    this._peer_data.set(peer_id, {
                        last_sent_message: 0,
                        last_received_message: Number.MAX_VALUE,
                        round_trip_time: 0,
                    });
                    this._room.send_message(this._encode_bounce_back_message(), peer_id);
                });
            },
            on_peer_left: (peer_id: PeerId) => {
                this._run_inner_function(async () => {
                    this._peer_data.delete(peer_id);

                    // TODO: This is a terrible way to handle peer disconnects.
                    // It has many potential unhandled edge-cases, but will work most of the time for now.

                    // Only one peer in the room will issue a `peer_left` event.
                    let closest_peer = this._room.my_id;
                    let peer_distance = this._room.my_id - peer_id;

                    for (const peer of this._peer_data.keys()) {
                        const diff = peer - peer_id;
                        if (diff != 0 && diff < peer_distance) {
                            closest_peer = peer;
                            peer_distance = diff;
                        }
                    }

                    console.log("[tangle] calling 'peer_left'");
                    if (closest_peer == this._room.my_id) {
                        this.call("peer_left", peer_id);
                    }
                });
            },
            on_state_change: (state: RoomState) => {
                this._run_inner_function(async () => {
                    console.log("[tangle] Room state changed: ", RoomState[state]);

                    switch (state) {
                        case RoomState.Connected: {
                            this._request_heap();

                            if (this._peer_data.size == 0) {
                                // We have no peer so we're connected
                                this._change_state(TangleState.Connected);
                            }
                            break;
                        }
                        case RoomState.Disconnected: {
                            this._change_state(TangleState.Disconnected);
                            break;
                        }
                        case RoomState.Joining: {
                            this._change_state(TangleState.Disconnected);
                            break;
                        }
                    }

                });
            },
            on_message: async (peer_id: PeerId, message: Uint8Array) => {
                const peer_connected_already = this._peer_data.get(peer_id);

                this._run_inner_function(async () => {
                    // Ignore messages from peers that have disconnected. 
                    // TODO: Evaluate if this could cause desyncs.
                    const peer = this._peer_data.get(peer_id);
                    if (!peer) {
                        console.log("[tangle] Rejected message from unconnected peer: ", peer_id);
                        return;
                    }

                    const message_type = message[0];
                    const message_data = message.subarray(1);

                    switch (message_type) {
                        case (MessageType.TimeProgressed): {
                            const time = this._decode_time_progressed_message(message_data);
                            peer.last_received_message = time;
                            break;
                        }
                        case (MessageType.WasmCall): {
                            const m = this._decode_wasm_call_message(message_data);
                            peer.last_received_message = m.time;

                            const time_stamp = {
                                time: m.time,
                                player_id: peer_id
                            };

                            if (this._tangle_state == TangleState.RequestingHeap) {
                                this._buffered_messages.push({
                                    function_export_index: m.function_index,
                                    time_stamp: time_stamp,
                                    args: m.args
                                });
                            } else {
                                console.log("Remote Wasm call: ", this._time_machine.get_function_name(m.function_index));
                                await this._time_machine.call_with_time_stamp(m.function_index, m.args, time_stamp, true);
                                if (!(this._time_machine._fixed_update_interval)) {
                                    this.progress_time();
                                }
                            }

                            break;
                        }
                        case (MessageType.RequestState): {
                            // TODO: Check that this is a fully loaded peer.
                            const heap_message = this._time_machine.encode(MessageType.SetHeap);
                            this._room.send_message(heap_message);
                            break;
                        }
                        case (MessageType.SetHeap): {
                            if (this._tangle_state != TangleState.Connected) {
                                console.log("[tangle] Applying TimeMachine state from peer");

                                const round_trip_time = peer.round_trip_time;
                                console.log("[tangle] Approximate round trip offset: ", round_trip_time / 2);
                                this._time_machine.decode_and_apply(new MessageWriterReader(message_data));

                                // Apply any messages that were received as we were waiting for this to load.
                                for (const m of this._buffered_messages) {
                                    await this._time_machine.call_with_time_stamp(m.function_export_index, m.args, m.time_stamp,);
                                }
                                this._buffered_messages = [];

                                // Progress the target time to approximately catch up to the remote peer.
                                this._time_machine.progress_time(round_trip_time / 2);

                                this._change_state(TangleState.Connected);
                            }
                            break;
                        }
                        case (MessageType.Ping): {
                            message[0] = MessageType.Pong;
                            this._room.send_message(message, peer_id);
                            break;
                        }
                        case (MessageType.Pong): {
                            const time = this._decode_bounce_back_return(message_data);
                            peer.round_trip_time = Date.now() - time;
                            break;
                        }
                    }
                }, !peer_connected_already);
            }
        };

        this._room = await Room.setup(room_configuration, this._rust_utilities);
        this._current_program_binary = wasm_binary;
    }

    private async _run_inner_function(f: () => void, enqueue_condition = false) {
        if (!this._block_reentrancy && !enqueue_condition) {
            this._block_reentrancy = true;
            await f();
            let f1 = this._enqueued_inner_calls.shift();
            while (f1) {
                await f1();
                f1 = this._enqueued_inner_calls.shift();
            }
            this._block_reentrancy = false;
        } else {
            this._enqueued_inner_calls.push(f);
        }
    }

    private _request_heap() {
        // Ask an arbitrary peer for the heap
        const lowest_latency_peer = this._room.get_lowest_latency_peer();
        if (lowest_latency_peer) {
            this._change_state(TangleState.RequestingHeap);
            this._room.send_message(this._encode_bounce_back_message(), lowest_latency_peer);
            this._room.send_message(this._encode_request_heap_message(), lowest_latency_peer);
        }
    }

    private _encode_wasm_call_message(function_index: number, time: number, args: Array<number> /*, hash?: Uint8Array*/): Uint8Array {
        const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
        message_writer.write_u8(MessageType.WasmCall);

        message_writer.write_u32(function_index);
        message_writer.write_f64(time);
        message_writer.write_u8(args.length);


        // Encode args. 
        // TODO: For now all args are encoded as f64s, but that is incorrect.
        for (let i = 0; i < args.length; i++) {
            message_writer.write_f64(args[i]);
        }

        /*
        if (this._debug_enabled) {
            message_writer.write_raw_bytes(hash!);
        }
        */

        return this._outgoing_message_buffer.subarray(0, message_writer.offset);
    }

    private _decode_wasm_call_message(data: Uint8Array) {
        const message_reader = new MessageWriterReader(data);

        const function_index = message_reader.read_u32();
        const time = message_reader.read_f64();
        const args_length = message_reader.read_u8();

        const args = new Array<number>(args_length);
        for (let i = 0; i < args.length; i++) {
            args[i] = message_reader.read_f64();
        }

        let hash;

        /*
        let hash;
        if (this._debug_enabled) {
            hash = message_reader.read_fixed_raw_bytes(16);
        }
        */

        return {
            function_index,
            time,
            args,
            hash
        };
    }

    private _encode_time_progressed_message(time_progressed: number): Uint8Array {
        const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
        message_writer.write_u8(MessageType.TimeProgressed);
        message_writer.write_f64(time_progressed);
        return message_writer.get_result_array();
    }

    private _decode_time_progressed_message(data: Uint8Array) {
        return new DataView(data.buffer, data.byteOffset).getFloat64(0);
    }

    private _encode_request_heap_message(): Uint8Array {
        this._outgoing_message_buffer[0] = MessageType.RequestState;
        return this._outgoing_message_buffer.subarray(0, 1);
    }

    private _encode_bounce_back_message(): Uint8Array {
        const writer = new MessageWriterReader(this._outgoing_message_buffer);
        writer.write_u8(MessageType.Ping);
        writer.write_f64(Date.now());
        return writer.get_result_array();
    }

    private _decode_bounce_back_return(data: Uint8Array): number {
        const reader = new MessageWriterReader(data);
        return reader.read_f64();
    }

    private _process_args(args: Array<number | UserIdType>): Array<number> {
        return args.map((a) => {
            if (typeof a != "number") {
                // Assume this is a UserId
                return this._room.my_id;
            } else {
                return a;
            }
        });
    }

    call(function_name: string, ...args: Array<number | UserIdType>) {
        this._run_inner_function(async () => {

            // TODO: Only process the args like this for local calls.
            // Let remote calls insert the ID themselves
            // As-is this design makes it trivial for peers to spoof each-other.
            const args_processed = this._process_args(args);

            const time_stamp = {
                time: this._time_machine.target_time() + this._message_time_offset,
                player_id: this._room.my_id
            };

            // Ensure events each have a unique timestamp.
            // In practice this tiny offset should be of no consequence.
            this._message_time_offset += .0001;

            // Adding time delay here decreases responsivity but also decreases the likelihood
            // peers will have to rollback.
            // This could be a good place to add delay if a peer has higher latency than 
            // everyone else in the room.
            // Adding a time delay would look something like this:
            // time_stamp.time += 50;

            const function_index = this._time_machine.get_function_export_index(function_name);
            if (function_index !== undefined) {
                await this._time_machine.call_with_time_stamp(function_index, args_processed, time_stamp, true);

                // Network the call
                this._room.send_message(this._encode_wasm_call_message(function_index, time_stamp.time, args_processed));

                for (const value of this._peer_data.values()) {
                    value.last_sent_message = Math.max(value.last_received_message, time_stamp.time);
                }
            }
        });

        if (!(this._time_machine._fixed_update_interval)) {
            this.progress_time();
        }
    }

    /// This call will have no impact but can be useful to draw or query from the world.
    call_and_revert(function_name: string, ...args: Array<number>) {
        this._run_inner_function(async () => {
            const args_processed = this._process_args(args);
            const function_index = this._time_machine.get_function_export_index(function_name);
            if (function_index) {
                this._time_machine.call_and_revert(function_index, args_processed);
            }
        });
    }

    /// Resync with the room, immediately catching up.
    resync() {
        this._run_inner_function(() => {
            this._request_heap();
        });
    }

    progress_time() {
        this._run_inner_function(async () => {
            await this._progress_time_inner();
        });
    }

    private async _progress_time_inner() {
        const performance_now = performance.now();

        if (this._last_performance_now) {
            let time_progressed = performance_now - this._last_performance_now;

            // If the client is over 2 seconds behind assume they need to be resynced.
            const time_diff = (this._time_machine.target_time() + time_progressed) - this._time_machine.current_simulation_time();
            if (this._time_machine._fixed_update_interval !== undefined && time_diff > 2000) {

                // TODO: This time change means that this peer cannot be trusted as an authority on the room simulation.
                // The peer should stop sending events and should absolutely not synchronize state with other peers.
                time_progressed = this._time_machine._fixed_update_interval;

                if (this._peer_data.size > 0) {
                    console.log("[tangle] Fallen over 2 seconds behind, attempting to resync with room");
                    this._request_heap();
                } else {
                    console.log("[tangle] Fallen over 2 seconds behind but this is a single-player session, so ignoring this");
                }
            }

            await this._time_machine.progress_time(time_progressed);

            const time_budget = time_progressed * 0.7;
            const time_here = performance.now();

            while (this._time_machine.step()) {
                // TODO: A better heuristic for when snapshots should be taken.
                // They could be taken after a set amount of computational overhead.
                this._time_machine.take_snapshot();
                if ((performance.now() - time_here) > time_budget) {
                    break;
                }
            }

            // Remove history that's safe to remove.

            // Keep track of when a message was received from each peer
            // and use that to determine what history is safe to throw away.
            let earliest_safe_memory = this._time_machine.current_simulation_time();
            for (const [peer_id, value] of this._peer_data) {
                earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);

                // If we haven't messaged our peers in a while send them a message
                // This lets them know nothing has happened and they can discard history.
                // I suspect the underlying RTCDataChannel protocol is sending keep alives as well,
                // it'd be better to figure out if those could be used instead.
                const KEEP_ALIVE_THRESHOLD = 200;
                const current_time = this._time_machine.target_time();
                if ((current_time - value.last_sent_message) > KEEP_ALIVE_THRESHOLD) {
                    this._room.send_message(this._encode_time_progressed_message(current_time), peer_id);
                }
            }

            // TODO: The -50 here is masking some sort of bug where a crash occurs because there's no available snapshot.
            this._time_machine.remove_history_before(earliest_safe_memory - 50);

            if (time_progressed > 0) {
                this._message_time_offset = 0;
            }
        }

        this._last_performance_now = performance_now;
    }

    read_memory(address: number, length: number): Uint8Array {
        return this._time_machine.read_memory(address, length);
    }
    read_string(address: number, length: number): string {
        return this._time_machine.read_string(address, length);
    }

    disconnect() {
        this._room.disconnect();
    }
}
