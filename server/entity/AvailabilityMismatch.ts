import type { MismatchStatus } from '@server/lib/availabilityMismatch';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import Media from './Media';
import { User } from './User';

/**
 * A season whose episode count in Plex differs from Sonarr's file count,
 * found by the Availability Check job (see server/lib/availabilityMismatch.ts).
 */
@Entity()
@Unique(['mediaId', 'seasonNumber'])
class AvailabilityMismatch {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public mediaId: number;

  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  public media?: Media;

  @Column()
  public seasonNumber: number;

  /** Series title from Sonarr at check time, so lists need no TMDB call. */
  @Column({ type: 'varchar', nullable: true })
  public title?: string | null;

  @Column({ type: 'int', default: 0 })
  public plexEpisodes: number;

  @Column({ type: 'int', default: 0 })
  public sonarrEpisodes: number;

  @Column({ type: 'varchar', default: 'open' })
  @Index()
  public status: MismatchStatus;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public firstSeenAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolvedAt?: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @Index()
  public resolvedBy?: User | null;

  constructor(init?: Partial<AvailabilityMismatch>) {
    Object.assign(this, init);
  }
}

export default AvailabilityMismatch;
