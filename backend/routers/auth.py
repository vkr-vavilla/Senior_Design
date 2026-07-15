from fastapi import APIRouter, HTTPException, status, Depends, Response, Cookie
from typing import Optional
from bson import ObjectId
from database import get_db
from models.user import UserRegister, UserLogin, UserOut, TokenResponse
from auth.jwt import hash_password, verify_password, create_access_token, create_refresh_token, verify_refresh_token, get_current_user

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


@router.post("/login", response_model=TokenResponse)
async def login(credentials: UserLogin, response: Response):
    db = get_db()
    user = await db.users.find_one({"email": credentials.email})
    if not user or not verify_password(credentials.password, user["password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user_id = str(user["_id"])
    access_token = create_access_token({"sub": user_id})
    refresh_token = create_refresh_token({"sub": user_id})
    
    # Store refresh token in MongoDB for stateful revocation
    await db.refresh_tokens.insert_one({
        "token": refresh_token,
        "user_id": user_id,
        "created_at": ObjectId() # Simple timestamp or datetime.utcnow()
    })
    
    # Set refresh token as httpOnly cookie
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=False, # Set to True in production with HTTPS
        samesite="lax",
        max_age=30 * 24 * 60 * 60 # 30 days
    )
    
    return TokenResponse(access_token=access_token)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(response: Response, refresh_token: Optional[str] = Cookie(None)):
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Refresh token missing")
    
    # Verify JWT signature and get user_id
    user_id = verify_refresh_token(refresh_token)
    
    # Verify token exists in MongoDB (Stateful check)
    db = get_db()
    token_doc = await db.refresh_tokens.find_one({"token": refresh_token})
    if not token_doc:
        raise HTTPException(status_code=401, detail="Refresh token revoked or invalid")
    
    # User must still exist
    user = await db.users.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Rotate refresh token: delete old, create new
    await db.refresh_tokens.delete_one({"token": refresh_token})
    
    new_access_token = create_access_token({"sub": user_id})
    new_refresh_token = create_refresh_token({"sub": user_id})
    
    # Store new refresh token
    await db.refresh_tokens.insert_one({
        "token": new_refresh_token,
        "user_id": user_id
    })
    
    # Update cookie
    response.set_cookie(
        key="refresh_token",
        value=new_refresh_token,
        httponly=True,
        secure=False, # Set to True in production
        samesite="lax",
        max_age=30 * 24 * 60 * 60
    )
    
    return TokenResponse(access_token=new_access_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response, refresh_token: Optional[str] = Cookie(None)):
    if refresh_token:
        db = get_db()
        await db.refresh_tokens.delete_one({"token": refresh_token})
    
    response.delete_cookie("refresh_token")
    return None


@router.get("/me", response_model=UserOut)
async def me(user_id: str = Depends(get_current_user)):
    db = get_db()
    user = await db.users.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserOut(id=str(user["_id"]), email=user["email"], name=user["name"])
