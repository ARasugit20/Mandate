use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("D2cW4yDMEP8aCxLEtuqifxJavNWYom2Nmx3GdSNRUsEG");

pub const MAX_LINES: usize = 6;
pub const FULL_AT: u8 = 90;

#[program]
pub mod mandate {
    use super::*;

    pub fn create_mandate(
        ctx: Context<CreateMandate>,
        mission_id: u64,
        expires_at: i64,
        lines: Vec<LineInput>,
    ) -> Result<()> {
        require!(expires_at > Clock::get()?.unix_timestamp, MandateError::MandateExpired);
        require!(lines.len() >= 1 && lines.len() <= MAX_LINES, MandateError::NoMatchingLineItem);
        let mut total: u64 = 0;
        let mut stored = [Line::default(); MAX_LINES];
        for (i, src) in lines.iter().enumerate() {
            require!(src.category <= 3, MandateError::NoMatchingLineItem);
            require!(src.min_score <= 100, MandateError::InvalidScore);
            total = total.checked_add(src.budget).ok_or(MandateError::LineBudgetExceeded)?;
            stored[i] = Line {
                category: src.category,
                budget: src.budget,
                committed: 0,
                spent: 0,
                max_unit_price: src.max_unit_price,
                min_score: src.min_score,
            };
        }
        require!(total > 0, MandateError::LineBudgetExceeded);

        let mandate = &mut ctx.accounts.mandate;
        mandate.owner = ctx.accounts.owner.key();
        mandate.agent = ctx.accounts.agent.key();
        mandate.verifier = ctx.accounts.verifier.key();
        mandate.mint = ctx.accounts.mint.key();
        mandate.mission_id = mission_id;
        mandate.total = total;
        mandate.paid_out = 0;
        mandate.expires_at = expires_at;
        mandate.closed = false;
        mandate.bump = ctx.bumps.mandate;
        mandate.line_count = lines.len() as u8;
        mandate.next_order_id = 0;
        mandate.lines = stored;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            total,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }

    pub fn register_provider(ctx: Context<RegisterProvider>) -> Result<()> {
        let stats = &mut ctx.accounts.provider_stats;
        stats.owner = ctx.accounts.owner.key();
        stats.provider = ctx.accounts.provider.key();
        stats.n = 0;
        stats.c_full = 0;
        stats.c_half = 0;
        stats.c_zero = 0;
        stats.sum_verified = 0;
        stats.sum_claimed = 0;
        stats.bump = ctx.bumps.provider_stats;
        Ok(())
    }

    pub fn purchase(
        ctx: Context<Purchase>,
        line_index: u8,
        unit_price: u64,
        full_amount: u64,
        claimed_score: u8,
    ) -> Result<()> {
        require!(claimed_score <= 100, MandateError::InvalidScore);
        let mandate_key = ctx.accounts.mandate.key();
        let owner = ctx.accounts.mandate.owner;
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.mandate.closed, MandateError::MandateClosed);
        require!(now <= ctx.accounts.mandate.expires_at, MandateError::MandateExpired);
        require!(
            ctx.accounts.agent.key() == ctx.accounts.mandate.agent,
            MandateError::NotAgent
        );

        load_stats(
            &ctx.accounts.provider_stats.to_account_info(),
            &owner,
            &ctx.accounts.provider.key(),
        )?;

        let idx = line_index as usize;
        require!(
            idx < ctx.accounts.mandate.line_count as usize,
            MandateError::NoMatchingLineItem
        );
        let cap = ctx.accounts.mandate.lines[idx].max_unit_price;
        require!(unit_price <= cap, MandateError::OverUnitPrice);
        let order_id = ctx.accounts.mandate.next_order_id;
        let min_score = ctx.accounts.mandate.lines[idx].min_score;
        let line = &mut ctx.accounts.mandate.lines[idx];
        let new_committed = line
            .committed
            .checked_add(full_amount)
            .ok_or(MandateError::LineBudgetExceeded)?;
        require!(new_committed <= line.budget, MandateError::LineBudgetExceeded);
        line.committed = new_committed;

        let half_enabled = min_score < FULL_AT;
        let order = &mut ctx.accounts.order;
        order.mandate = mandate_key;
        order.order_id = order_id;
        order.provider = ctx.accounts.provider.key();
        order.line_index = line_index;
        order.full_amount = full_amount;
        order.claimed_score = claimed_score;
        order.settled = false;
        order.score = 0;
        order.paid = 0;
        order.full_at = FULL_AT;
        order.half_at = min_score;
        order.half_enabled = half_enabled;
        order.bump = ctx.bumps.order;
        ctx.accounts.mandate.next_order_id = order_id.checked_add(1).unwrap();
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>, score: u8) -> Result<()> {
        require!(score <= 100, MandateError::InvalidScore);
        require!(!ctx.accounts.mandate.closed, MandateError::MandateClosed);
        require!(!ctx.accounts.order.settled, MandateError::OrderAlreadySettled);
        require!(
            ctx.accounts.verifier.key() == ctx.accounts.mandate.verifier,
            MandateError::NotVerifier
        );
        require_keys_eq!(ctx.accounts.order.mandate, ctx.accounts.mandate.key());

        require_keys_eq!(ctx.accounts.provider_ata.owner, ctx.accounts.order.provider);
        require_keys_eq!(ctx.accounts.provider_stats.provider, ctx.accounts.order.provider);

        let full = ctx.accounts.order.full_amount;
        let half = full / 2;
        let paid = if score >= ctx.accounts.order.full_at {
            full
        } else if ctx.accounts.order.half_enabled && score >= ctx.accounts.order.half_at {
            half
        } else {
            0
        };

        let idx = ctx.accounts.order.line_index as usize;
        let line = &mut ctx.accounts.mandate.lines[idx];
        line.committed = line.committed.saturating_sub(full);
        line.spent = line.spent.checked_add(paid).unwrap();
        ctx.accounts.mandate.paid_out = ctx.accounts.mandate.paid_out.checked_add(paid).unwrap();

        if paid > 0 {
            let bump = ctx.accounts.mandate.bump;
            let owner = ctx.accounts.mandate.owner;
            let mission_id = ctx.accounts.mandate.mission_id;
            let seeds: &[&[u8]] = &[b"mandate", owner.as_ref(), &mission_id.to_le_bytes(), &[bump]];
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.provider_ata.to_account_info(),
                        authority: ctx.accounts.mandate.to_account_info(),
                    },
                    &[seeds],
                ),
                paid,
                ctx.accounts.mint.decimals,
            )?;
        }

        ctx.accounts.order.settled = true;
        ctx.accounts.order.score = score;
        ctx.accounts.order.paid = paid;

        let stats = &mut ctx.accounts.provider_stats;
        stats.n = stats.n.checked_add(1).unwrap();
        stats.sum_verified = stats.sum_verified.checked_add(score as u64).unwrap();
        stats.sum_claimed = stats
            .sum_claimed
            .checked_add(ctx.accounts.order.claimed_score as u64)
            .unwrap();
        if paid == full {
            stats.c_full += 1;
        } else if paid > 0 {
            stats.c_half += 1;
        } else {
            stats.c_zero += 1;
        }

        emit!(Settled {
            mandate: ctx.accounts.mandate.key(),
            order_id: ctx.accounts.order.order_id,
            score,
            paid,
        });
        Ok(())
    }

    pub fn close_mandate(ctx: Context<CloseMandate>) -> Result<()> {
        require!(!ctx.accounts.mandate.closed, MandateError::MandateClosed);
        require!(
            ctx.accounts.owner.key() == ctx.accounts.mandate.owner,
            MandateError::NotOwner
        );
        for i in 0..ctx.accounts.mandate.line_count as usize {
            require!(
                ctx.accounts.mandate.lines[i].committed == 0,
                MandateError::PendingOrders
            );
        }
        let remaining = ctx.accounts.vault.amount;
        let bump = ctx.accounts.mandate.bump;
        let owner_pk = ctx.accounts.mandate.owner;
        let mission_id = ctx.accounts.mandate.mission_id;
        let seeds: &[&[u8]] = &[b"mandate", owner_pk.as_ref(), &mission_id.to_le_bytes(), &[bump]];
        if remaining > 0 {
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.owner_ata.to_account_info(),
                        authority: ctx.accounts.mandate.to_account_info(),
                    },
                    &[seeds],
                ),
                remaining,
                ctx.accounts.mint.decimals,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.mandate.to_account_info(),
            },
            &[seeds],
        ))?;
        ctx.accounts.mandate.closed = true;
        Ok(())
    }
}

fn load_stats(
    acc: &AccountInfo,
    owner: &Pubkey,
    provider: &Pubkey,
) -> Result<ProviderStats> {
    let (expected, _) = Pubkey::find_program_address(&[b"provider", owner.as_ref(), provider.as_ref()], &ID);
    require_keys_eq!(acc.key(), expected, MandateError::ProviderNotRegistered);
    require!(
        *acc.owner == ID && acc.data_len() >= 8 + ProviderStats::INIT_SPACE,
        MandateError::ProviderNotRegistered
    );
    let data = acc.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    ProviderStats::try_deserialize(&mut slice).map_err(|_| MandateError::ProviderNotRegistered.into())
}

#[derive(Accounts)]
#[instruction(mission_id: u64)]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: stored as agent
    pub agent: UncheckedAccount<'info>,
    /// CHECK: stored as verifier
    pub verifier: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [b"mandate", owner.key().as_ref(), &mission_id.to_le_bytes()],
        bump,
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = mandate,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterProvider<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: provider identity
    pub provider: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + ProviderStats::INIT_SPACE,
        seeds = [b"provider", owner.key().as_ref(), provider.key().as_ref()],
        bump,
    )]
    pub provider_stats: Account<'info, ProviderStats>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Purchase<'info> {
    #[account(
        mut,
        seeds = [b"mandate", mandate.owner.as_ref(), &mandate.mission_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = agent @ MandateError::NotAgent,
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(mut)]
    pub agent: Signer<'info>,
    /// CHECK: provider identity
    pub provider: UncheckedAccount<'info>,
    /// CHECK: deserialized in handler
    pub provider_stats: UncheckedAccount<'info>,
    #[account(
        init,
        payer = agent,
        space = 8 + Order::INIT_SPACE,
        seeds = [b"order", mandate.key().as_ref(), &mandate.next_order_id.to_le_bytes()],
        bump,
    )]
    pub order: Account<'info, Order>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"mandate", mandate.owner.as_ref(), &mandate.mission_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = verifier @ MandateError::NotVerifier,
    )]
    pub mandate: Account<'info, Mandate>,
    pub verifier: Signer<'info>,
    #[account(
        mut,
        seeds = [b"order", mandate.key().as_ref(), &order.order_id.to_le_bytes()],
        bump = order.bump,
    )]
    pub order: Account<'info, Order>,
    #[account(
        mut,
        seeds = [b"provider", mandate.owner.as_ref(), order.provider.as_ref()],
        bump = provider_stats.bump,
    )]
    pub provider_stats: Account<'info, ProviderStats>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = mandate,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub provider_ata: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"mandate", mandate.owner.as_ref(), &mandate.mission_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = owner @ MandateError::NotOwner,
        has_one = mint,
    )]
    pub mandate: Account<'info, Mandate>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = mandate,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub verifier: Pubkey,
    pub mint: Pubkey,
    pub mission_id: u64,
    pub total: u64,
    pub paid_out: u64,
    pub expires_at: i64,
    pub closed: bool,
    pub bump: u8,
    pub line_count: u8,
    pub next_order_id: u64,
    pub lines: [Line; MAX_LINES],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Line {
    pub category: u8,
    pub budget: u64,
    pub committed: u64,
    pub spent: u64,
    pub max_unit_price: u64,
    pub min_score: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LineInput {
    pub category: u8,
    pub budget: u64,
    pub max_unit_price: u64,
    pub min_score: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub mandate: Pubkey,
    pub order_id: u64,
    pub provider: Pubkey,
    pub line_index: u8,
    pub full_amount: u64,
    pub claimed_score: u8,
    pub settled: bool,
    pub score: u8,
    pub paid: u64,
    pub full_at: u8,
    pub half_at: u8,
    pub half_enabled: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ProviderStats {
    pub owner: Pubkey,
    pub provider: Pubkey,
    pub n: u64,
    pub c_full: u64,
    pub c_half: u64,
    pub c_zero: u64,
    pub sum_verified: u64,
    pub sum_claimed: u64,
    pub bump: u8,
}

#[event]
pub struct Settled {
    pub mandate: Pubkey,
    pub order_id: u64,
    pub score: u8,
    pub paid: u64,
}

#[error_code]
pub enum MandateError {
    #[msg("Signer is not the mandate agent")]
    NotAgent,
    #[msg("Signer is not the mandate verifier")]
    NotVerifier,
    #[msg("Signer is not the mandate owner")]
    NotOwner,
    #[msg("Mandate has expired")]
    MandateExpired,
    #[msg("Mandate is closed")]
    MandateClosed,
    #[msg("Line index does not match the plan")]
    NoMatchingLineItem,
    #[msg("Unit price exceeds the line cap")]
    OverUnitPrice,
    #[msg("Line budget exceeded")]
    LineBudgetExceeded,
    #[msg("Provider is not registered")]
    ProviderNotRegistered,
    #[msg("Order already settled")]
    OrderAlreadySettled,
    #[msg("Score must be 0-100")]
    InvalidScore,
    #[msg("Pending orders remain")]
    PendingOrders,
}
