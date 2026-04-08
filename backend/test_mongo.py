
import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from config import MONGODB_URI, DB_NAME

async def test_conn():
    print(f"Connecting to {MONGODB_URI[:30]}...")
    client = AsyncIOMotorClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    try:
        # The ismaster command is cheap and does not require auth.
        await client.admin.command('ismaster')
        print("MongoDB Connection Successful!")
    except Exception as e:
        print(f"MongoDB Connection Failed: {e}")

if __name__ == "__main__":
    asyncio.run(test_conn())
