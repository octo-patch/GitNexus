package services

import models.getUser

fun processUser() {
    val user = getUser("alice")
    user.save()
}
