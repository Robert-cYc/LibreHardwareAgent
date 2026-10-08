import sqlite3
import time
from contextlib import contextmanager
import os

DB_PATH = "hardware_data.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sensor_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL,
            identifier TEXT,
            name TEXT,
            sensor_type TEXT,
            value REAL
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_timestamp ON sensor_data(timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_identifier ON sensor_data(identifier)')
    conn.commit()
    conn.close()

@contextmanager
def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()

def insert_sensor_data(records):
    """
    records: list of tuples (timestamp, identifier, name, sensor_type, value)
    """
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.executemany('''
            INSERT INTO sensor_data (timestamp, identifier, name, sensor_type, value)
            VALUES (?, ?, ?, ?, ?)
        ''', records)
        conn.commit()

def get_historical_data(identifier: str, minutes: int = 15):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cutoff_time = time.time() - (minutes * 60)
        cursor.execute('''
            SELECT timestamp, value FROM sensor_data
            WHERE identifier = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        ''', (identifier, cutoff_time))
        return cursor.fetchall()
