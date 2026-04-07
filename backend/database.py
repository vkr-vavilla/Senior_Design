from motor.motor_asyncio import AsyncIOMotorClient
from config import MONGODB_URI, DB_NAME

client: AsyncIOMotorClient = None
db = None


import certifi

async def connect_db():
    global client, db
    try:
        client = AsyncIOMotorClient(MONGODB_URI, tlsCAFile=certifi.where())
        db = client[DB_NAME]
        # Trigger a test command to verify connection early
        await client.admin.command('ismaster')
        print(f"Connected to MongoDB: {DB_NAME}")
    except Exception as e:
        print(f"Failed to connect to MongoDB: {e}")
        # We don't raise here to allow the app to start, 
        # but subsequent DB ops will fail predictably.


async def close_db():
    global client
    if client:
        client.close()
        print("MongoDB connection closed")


def get_db():
    return db
