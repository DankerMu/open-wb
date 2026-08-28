"""Toy training script standing in for a real benchmark harness.

Fixture only. Prints a metric block in the shape the Scoreboard contract parses.
"""
import time

LEARNING_RATE = 0.02
BATCH_SIZE = 32
DEPTH = 8


def train():
    start = time.time()
    # A real script trains here. The fixture only needs the output shape.
    val_bpb = 1.0012
    print("---")
    print(f"val_bpb:          {val_bpb:.6f}")
    print(f"training_seconds: {time.time() - start:.1f}")
    print(f"depth:            {DEPTH}")


if __name__ == "__main__":
    train()
