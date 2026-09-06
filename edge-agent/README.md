# Edge agent reference (heartbeat only)

The production Raspberry Pi agent lives outside this repo. This folder provides a
drop-in **heartbeat publisher** that must be integrated into that agent.

- Module: [`heartbeat_publisher.py`](./heartbeat_publisher.py)
- Does not implement RS485 or transaction upload
- Publishes every 30s even when the pump is idle/powered off

Full cloud contract, deploy steps, and rollback: [../docs/edge-device-heartbeat.md](../docs/edge-device-heartbeat.md)
