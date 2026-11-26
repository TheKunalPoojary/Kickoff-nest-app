import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodValidationPipe, zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { AdminService } from './admin.service.js';
import {
  AdminBookingsSchema,
  AdminCreateVenueSchema,
  AdminUpdateVenueSchema,
  CreateOwnerSchema,
  ListUsersSchema,
  ListVenuesSchema,
  UpdateUserSchema,
  type AdminBookingsDto,
  type AdminCreateVenueDto,
  type AdminUpdateVenueDto,
  type CreateOwnerDto,
  type ListUsersDto,
  type ListVenuesDto,
  type UpdateUserDto,
} from './admin.schemas.js';

/**
 * Platform super-admin. ADMIN only — RolesGuard treats ADMIN as a superset, so
 * naming it here admits nobody else. Admins also pass VenueOwnershipGuard, so
 * every /owner route works for them against any venue.
 */
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('owners')
  createOwner(@CurrentUser() user: AuthUser, @Body(zodBody(CreateOwnerSchema)) dto: CreateOwnerDto) {
    return this.admin.createOwner(user, dto);
  }

  @Get('owners')
  listOwners() {
    return this.admin.listOwners();
  }

  @Get('users')
  listUsers(@Query(new ZodValidationPipe(ListUsersSchema)) query: ListUsersDto) {
    return this.admin.listUsers(query);
  }

  @Patch('users/:userId')
  updateUser(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
    @Body(zodBody(UpdateUserSchema)) dto: UpdateUserDto,
  ) {
    return this.admin.updateUser(user, userId, dto);
  }

  @Get('venues')
  listVenues(@Query(new ZodValidationPipe(ListVenuesSchema)) query: ListVenuesDto) {
    return this.admin.listVenues(query);
  }

  @Post('venues')
  createVenue(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(AdminCreateVenueSchema)) dto: AdminCreateVenueDto,
  ) {
    return this.admin.createVenue(user, dto);
  }

  @Patch('venues/:venueId')
  updateVenue(
    @CurrentUser() user: AuthUser,
    @Param('venueId') venueId: string,
    @Body(zodBody(AdminUpdateVenueSchema)) dto: AdminUpdateVenueDto,
  ) {
    return this.admin.updateVenue(user, venueId, dto);
  }

  @Get('bookings')
  listBookings(@Query(new ZodValidationPipe(AdminBookingsSchema)) query: AdminBookingsDto) {
    return this.admin.listBookings(query);
  }

  @Get('audit-log')
  auditLog() {
    return this.admin.auditLog();
  }
}
