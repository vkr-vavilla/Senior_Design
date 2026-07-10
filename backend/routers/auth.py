from fastapi import APIRouter, HTTPException, status, Depends, Response, Cookie
from bson import ObjectId
from database import get_db
from models.user import UserRegister, UserLogin, UserOut
from auth.jwt import (
    hash_password, 
    verify_password, 
    create_access_token, 
    create_refresh_token, 
    verify_refresh_token, 
    get_current_user
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut)
async def register(user: UserRegister):
    db = get_db()
    existing = await db.users.find_one({"email": user.email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    new_user = {
        "email": user.email,
        "name": user.name,
        "password": hash_password(user.password),
    }
    result = await db.users.insert_one(new_user)
    return UserOut(id=str(result.inserted_id), email=user.email, name=user.name)


@router.post("/login")
async def login(credentials: UserLogin, response: Response):
    db = get_db()
    user = await db.users.find_one({"email": credentials.email})
    if not user or not verify_password(credentials.password, user["password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user_id = str(user["_id"])
    access_token = create_access_token({"sub": user_id})
    refresh_token = create_refresh_token({"sub": user_id})

    # Store refresh token in MongoDB
    await db.refresh_tokens.insert_one({
        "user_id": user_id,
        "token": refresh_token,
    })

    # Set refresh token as httpOnly cookie
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        samesite="lax",
        secure=False, # Set to True in production (HTTPS)
    )

    return {"access_token": access_token, "token_type": "bearer"}


@router.post("/refresh")
async def refresh(refresh_token: Cookie = Cookie(None)):
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Refresh token missing")

    user_id = verify_refresh_token(refresh_token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    db = get_db()
    # Verify token exists in DB (hasn't been revoked)
    token_exists = await db.refresh_tokens.find_one({"token": refresh_token})
    if not token_exists:
        raise HTTPException(status_code=401, detail="Refresh token revoked")

    # Issue new access token
    new_access_token = create_access_token({"sub": user_id})
    return {"access_token": new_access_token, "token_type": "bearer"}


@router.post("/logout")
async def logout(response: Response, refresh_token: Cookie = Cookie(None)):
    if refresh_token:
        db = get_db()
        await db.refresh_tokens.delete_many({"token": refresh_token})

    response.delete_cookie("refresh_token")
    return {"detail": "Successfully logged out"}


@router.get("/me", response_model=UserOut)
async def me(user_id: str = Depends(get_current_user)):
    db = get_db()
    user = await db.users.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserOut(id=str(user["_id"]), email=user["email"], name=user["name"])
