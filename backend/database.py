from motor.motor_asyncio import AsyncIOMotorClient
from config import MONGODB_URI, DB_NAME

client: AsyncIOMotorClient = None
db = None


import certifi


def mongo_client_kwargs(uri: str = MONGODB_URI) -> dict:
    """TLS kwargs for a Mongo client, decided by the URI. Atlas (mongodb+srv)
    needs certifi's CA bundle, but passing any tls* kwarg implicitly turns TLS
    on — which a plain local mongo container rejects."""
    u = uri.lower()
    if u.startswith("mongodb+srv://") or "tls=true" in u or "ssl=true" in u:
        return {"tlsCAFile": certifi.where()}
    return {}


async def connect_db():
    global client, db
    client = AsyncIOMotorClient(MONGODB_URI, **mongo_client_kwargs())
    db = client[DB_NAME]
    await client.admin.command('ismaster')
    print(f"Connected to MongoDB: {DB_NAME}")


async def close_db():
    global client
    if client:
        client.close()
        print("MongoDB connection closed")


def get_db():
    return db
