import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from postgres_db import PostgresDatabase

async def main():
    db = PostgresDatabase("postgresql://knowmon:knowmon@localhost:5433/knowmon")
    
    col = db["test_verify"]
    await col._ensure_table()
    await col.delete_many({})
    
    r1 = await col.insert_one({"name": "Alice", "role": "admin", "score": 95, "tags": ["qa", "lead"]})
    r2 = await col.insert_one({"name": "Bob", "role": "agent", "score": 82, "tags": ["agent"]})
    r3 = await col.insert_one({"name": "Charlie", "role": "agent", "score": 88, "tags": ["agent", "trainee"]})
    print("Inserted IDs:", r1.inserted_id, r2.inserted_id, r3.inserted_id)
    
    docs = await col.find({"role": "agent"}, {"_id": 0, "name": 1, "score": 1}).sort("score", -1).to_list(10)
    print("Found agents sorted:", docs)
    assert len(docs) == 2
    assert docs[0]["name"] == "Charlie"
    
    count = await col.count_documents({"role": "agent"})
    print("Agent count:", count)
    assert count == 2
    tags = await col.distinct("tags")
    print("Distinct tags:", tags)
    
    await col.update_one({"name": "Bob"}, {"$set": {"score": 90}, "$push": {"tags": "promoted"}})
    bob = await col.find_one({"name": "Bob"}, {"_id": 0})
    print("Updated Bob:", bob)
    assert bob["score"] == 90
    assert "promoted" in bob["tags"]
    
    agg = await col.aggregate([
        {"$group": {"_id": "$role", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}
    ]).to_list()
    print("Aggregate:", agg)
    
    await col.delete_many({})
    print("ALL POSTGRES TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    asyncio.run(main())
