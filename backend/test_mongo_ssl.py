
import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from config import MONGODB_URI, DB_NAME
import certifi

async def test_conn():
    print(f"Connecting to MongoDB...")
    # Try with certifi
    client = AsyncIOMotorClient(MONGODB_URI, tlsCAFile=certifi.where())
    try:
        await client.admin.command('ismaster')
        print("Success with certifi!")
        return
    except Exception as e:
        print(f"Failed with certifi: {e}")

    # Try with tlsAllowInvalidCertificates
    client = AsyncIOMotorClient(MONGODB_URI, tlsAllowInvalidCertificates=True)
    try:
        await client.admin.command('ismaster')
        print("Success with tlsAllowInvalidCertificates!")
        return
    except Exception as e:
        print(f"Failed with tlsAllowInvalidCertificates: {e}")

if __name__ == "__main__":
    asyncio.run(test_conn())
